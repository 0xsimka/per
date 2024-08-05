use anchor_lang::prelude::*;

#[account]
pub struct TokenAmount {
    pub mint: Pubkey,
    pub amount: u64,
}

#[account]
pub struct TokenAmountFulfilled {
    pub mint: Pubkey,
    pub amount: u64,
    pub fulfilled: u64,
}

pub const RESERVE_INTENT_ACCOUNTING: usize = 500;
pub const SEED_INTENT_ACCOUNTING: &[u8] = b"intent_accounting";

#[account]
#[derive(Default)]
pub struct IntentAccounting {
    pub sell_tokens: Vec<TokenAmountFulfilled>,
    pub buy_tokens: Vec<TokenAmount>,
    pub initialized: bool,
    pub cancelled: bool,
}
