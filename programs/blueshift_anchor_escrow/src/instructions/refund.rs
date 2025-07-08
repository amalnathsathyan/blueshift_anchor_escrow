#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface::*;
use anchor_spl::associated_token::*;
use crate::state::Escrow;
use crate::error::EscrowError;

/// The handler function for the refund instruction.
/// It calls the business logic to perform the refund.
pub fn handler(ctx: Context<Refund>) -> Result<()> {
    ctx.accounts.refund_and_close_vault()
}

/// Defines the accounts required for the refund instruction.
#[derive(Accounts)]
pub struct Refund<'info> {
    /// The maker of the escrow, who is initiating the refund.
    /// This account will receive the rent lamports from the closed accounts
    /// and will pay for the ATA creation if needed.
    #[account(mut)]
    pub maker: Signer<'info>,

    /// The escrow account holds the state of the trade.
    /// It's closed at the end of the instruction, and its lamports are sent to the maker.
    #[account(
        mut,
        close = maker,
        seeds = [b"escrow", maker.key().as_ref(), escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump,
        has_one = maker @ EscrowError::InvalidMaker,
        has_one = mint_a @ EscrowError::InvalidMintA
    )]
    pub escrow: Account<'info, Escrow>,

    /// The mint of the token being refunded (Token A).
    pub mint_a: InterfaceAccount<'info, Mint>,

    /// The vault is the token account owned by the escrow, holding the maker's tokens.
    /// It will be emptied and closed.
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = escrow
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// The maker's associated token account for Token A.
    /// This is where the refunded tokens will be sent.
    /// We use `init_if_needed` to ensure this account exists.
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = mint_a,
        associated_token::authority = maker
    )]
    pub maker_ata_a: InterfaceAccount<'info, TokenAccount>,

    /// The Associated Token Program, required for creating and managing ATAs.
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// The SPL Token Program, required for token operations like transfer and close.
    pub token_program: Interface<'info, TokenInterface>,
    /// The System Program, required by Anchor for account management.
    pub system_program: Program<'info, System>,
}

impl<'info> Refund<'info> {
    /// # Refund and Close Vault
    ///
    /// This function handles the core logic for the refund.
    /// 1. Transfers the entire token balance from the `vault` back to the `maker_ata_a`.
    /// 2. Closes the `vault` account, returning its rent lamports to the `maker`.
    ///
    /// The `escrow` account is closed automatically by the Anchor runtime due to the
    /// `close = maker` constraint in the `Refund` struct.
    fn refund_and_close_vault(&self) -> Result<()> {
        // These are the signer seeds required for the escrow PDA to sign for CPIs.
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"escrow",
            self.maker.to_account_info().key.as_ref(),
            &self.escrow.seed.to_le_bytes()[..],
            &[self.escrow.bump],
        ]];

        // CPI to the token program to transfer all tokens from the vault back to the maker.
        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                TransferChecked {
                    from: self.vault.to_account_info(),
                    mint: self.mint_a.to_account_info(),
                    to: self.maker_ata_a.to_account_info(),
                    authority: self.escrow.to_account_info(), // The escrow is the authority of the vault
                },
                &signer_seeds
            ),
            self.vault.amount, // Refund the entire balance of the vault
            self.mint_a.decimals
        )?;

        // CPI to the token program to close the now-empty vault account.
        // The rent lamports are returned to the `destination` account, which is the maker.
        close_account(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                CloseAccount {
                    account: self.vault.to_account_info(),
                    destination: self.maker.to_account_info(),
                    authority: self.escrow.to_account_info(),
                },
                &signer_seeds
            )
        )?;

        Ok(())
    }
}
