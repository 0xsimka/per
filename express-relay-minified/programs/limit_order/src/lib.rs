pub mod state;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, Transfer, TokenAccount, transfer, Approve, approve};
use crate::state::*;

declare_id!("6Pv94K3DycMf9nGJumN7z7SrydGErEjVjsYVXC5b31RN");

#[program]
pub mod limit_order {
    use super::*;

    pub fn fulfill_order(ctx: Context<FulfillOrder>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct FulfillOrder<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    // #[account()]
    // pub order_info: Account<'info, OrderInfo>,
    #[account()]
    pub taker_sell_token_account: Account<'info, TokenAccount>,
    #[account()]
    pub taker_buy_token_account: Account<'info, TokenAccount>,
    #[account()]
    pub maker_buy_token_account: Account<'info, TokenAccount>,
    #[account()]
    pub maker_sell_token_account: Account<'info, TokenAccount>,
    #[account()]
    pub token_program: Program<'info, Token>,
    #[account()]
    pub system_program: Program<'info, System>,
}
