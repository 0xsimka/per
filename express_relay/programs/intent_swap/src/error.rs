use anchor_lang::prelude::*;

#[error_code]
pub enum IntentSwapError {
    #[msg("Deadline passed")]
    DeadlinePassed,
    #[msg("Deadline (ER) has not passed")]
    DeadlineERNotPassed,
}
