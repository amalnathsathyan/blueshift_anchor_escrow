import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { BlueshiftAnchorEscrow } from "../target/types/blueshift_anchor_escrow";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("blueshift_anchor_escrow", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BlueshiftAnchorEscrow as Program<BlueshiftAnchorEscrow>;

  // Wallets and accounts
  let maker: Keypair;
  let taker: Keypair;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerAtaA: PublicKey;
  let makerAtaB: PublicKey;
  let takerAtaA: PublicKey;
  let takerAtaB: PublicKey;
  let escrow: PublicKey;
  let vault: PublicKey;

  // Escrow parameters
  const seed = new BN(Math.floor(Math.random() * 1000000));
  const depositAmount = new BN(100 * 10 ** 6); // 100 Token A
  const receiveAmount = new BN(50 * 10 ** 6);  // 50 Token B

  // Helper function to create a new mint
  const createMint = async (): Promise<PublicKey> => {
    const mintKeypair = Keypair.generate();
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    const transaction = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        6, // 6 decimals
        provider.wallet.publicKey,
        provider.wallet.publicKey
      )
    );

    await provider.sendAndConfirm(transaction, [mintKeypair]);
    return mintKeypair.publicKey;
  };

  // Set up the initial state before running tests
  before(async () => {
    // Generate new wallets for maker and taker
    maker = Keypair.generate();
    taker = Keypair.generate();

    // Airdrop SOL to the wallets
    const makerAirdrop = await provider.connection.requestAirdrop(maker.publicKey, LAMPORTS_PER_SOL);
    const takerAirdrop = await provider.connection.requestAirdrop(taker.publicKey, LAMPORTS_PER_SOL);
    
    // Confirming transactions
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        signature: makerAirdrop,
    });
    await provider.connection.confirmTransaction({
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        signature: takerAirdrop,
    });


    // Create token mints
    mintA = await createMint();
    mintB = await createMint();

    // Create ATAs and mint tokens
    makerAtaA = await getAssociatedTokenAddress(mintA, maker.publicKey);
    makerAtaB = await getAssociatedTokenAddress(mintB, maker.publicKey);
    takerAtaA = await getAssociatedTokenAddress(mintA, taker.publicKey);
    takerAtaB = await getAssociatedTokenAddress(mintB, taker.publicKey);

    const tx = new Transaction().add(
      // Create Maker's ATAs
      createAssociatedTokenAccountInstruction(maker.publicKey, makerAtaA, maker.publicKey, mintA),
      createAssociatedTokenAccountInstruction(maker.publicKey, makerAtaB, maker.publicKey, mintB),
      // Create Taker's ATAs
      createAssociatedTokenAccountInstruction(taker.publicKey, takerAtaA, taker.publicKey, mintA),
      createAssociatedTokenAccountInstruction(taker.publicKey, takerAtaB, taker.publicKey, mintB),
      // Mint 1000 Token A to Maker
      createMintToInstruction(mintA, makerAtaA, provider.wallet.publicKey, 1000 * 10 ** 6),
      // Mint 1000 Token B to Taker
      createMintToInstruction(mintB, takerAtaB, provider.wallet.publicKey, 1000 * 10 ** 6)
    );
    // Sign with maker and taker because they are payers for their ATAs
    await provider.sendAndConfirm(tx, [maker, taker]);

    // Find PDAs
    [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), seed.toBuffer('le', 8)],
      program.programId
    );
    // The vault is an ATA owned by the escrow PDA, so we find its address that way.
    vault = await getAssociatedTokenAddress(mintA, escrow, true);
  });

  it("Makes an escrow", async () => {
    await program.methods
      .make(seed, receiveAmount, depositAmount)
      .accounts({
        maker: maker.publicKey,
        escrow,
        mintA,
        mintB,
        makerAtaA,
        vault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Assert that the vault has the deposited amount
    const vaultBalance = await provider.connection.getTokenAccountBalance(vault);
    assert.strictEqual(vaultBalance.value.amount, depositAmount.toString());
  });

  it("Takes an escrow", async () => {
    await program.methods
      .take()
      .accounts({
        taker: taker.publicKey,
        maker: maker.publicKey,
        escrow,
        mintA,
        mintB,
        vault,
        takerAtaA,
        takerAtaB,
        makerAtaB,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    // Assert balances after the swap
    const makerAtaBBalance = await provider.connection.getTokenAccountBalance(makerAtaB);
    assert.strictEqual(makerAtaBBalance.value.amount, receiveAmount.toString());

    const takerAtaABalance = await provider.connection.getTokenAccountBalance(takerAtaA);
    assert.strictEqual(takerAtaABalance.value.amount, depositAmount.toString());

    // Assert that the vault and escrow accounts are closed
    const vaultInfo = await provider.connection.getAccountInfo(vault);
    assert.isNull(vaultInfo);
    const escrowInfo = await provider.connection.getAccountInfo(escrow);
    assert.isNull(escrowInfo);
  });

  it("Refunds an escrow", async () => {
    // Create a new escrow to refund
    const refundSeed = new BN(Math.floor(Math.random() * 1000000));
    const [refundEscrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), refundSeed.toBuffer('le', 8)],
      program.programId
    );
    const refundVault = await getAssociatedTokenAddress(mintA, refundEscrow, true);

    // Get initial balance of maker's ATA for Token A
    const initialMakerBalance = (await provider.connection.getTokenAccountBalance(makerAtaA)).value.uiAmount;

    // Make the escrow
    await program.methods
      .make(refundSeed, new BN(1), depositAmount)
      .accounts({
        maker: maker.publicKey,
        escrow: refundEscrow,
        mintA,
        mintB,
        makerAtaA,
        vault: refundVault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Refund the escrow
    await program.methods
      .refund()
      .accounts({
        maker: maker.publicKey,
        escrow: refundEscrow,
        mintA,
        vault: refundVault,
        makerAtaA,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Assert that the maker got their tokens back
    const finalMakerBalance = (await provider.connection.getTokenAccountBalance(makerAtaA)).value.uiAmount;
    assert.strictEqual(finalMakerBalance, initialMakerBalance);

    // Assert that the vault and escrow accounts are closed
    const vaultInfo = await provider.connection.getAccountInfo(refundVault);
    assert.isNull(vaultInfo);
    const escrowInfo = await provider.connection.getAccountInfo(refundEscrow);
    assert.isNull(escrowInfo);
  });
});
