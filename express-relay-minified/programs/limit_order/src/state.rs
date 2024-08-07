use anchor_lang::prelude::*;


#[account]
#[derive(Default)]
pub struct OrderInfo {
    pub buy_mint: Pubkey,
    pub sell_mint: Pubkey,
    pub buy_amount: u64,
    pub sell_amount: u64,
    pub maker: Pubkey,
}
