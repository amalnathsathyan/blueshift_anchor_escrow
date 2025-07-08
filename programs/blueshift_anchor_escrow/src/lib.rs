use anchor_lang::prelude::*;
 
pub mod state;
pub mod error;
pub mod instructions;
use instructions::*;

declare_id!("37hREAxtmQVqpQ85kwSkB7UiMpUeP2rHrW5Y5ZxYSxLh");
 
#[program]
pub mod blueshift_anchor_escrow {
    use super::*;
 
    // The tutorial requires manual discriminators for each instruction.
    // We also need to pass the arguments through this function to the handler.
    #[instruction(discriminator = 0)]
    pub fn make(ctx: Context<Make>, seed: u64, receive: u64, amount: u64) -> Result<()> {
        instructions::make::handler(ctx, seed, receive, amount)
    }
 
    #[instruction(discriminator = 1)]
    pub fn take(ctx: Context<Take>) -> Result<()> {
        instructions::take::handler(ctx)
    }
 
    #[instruction(discriminator = 2)]
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund::handler(ctx)
    }
}
