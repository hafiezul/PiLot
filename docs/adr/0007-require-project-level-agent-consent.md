# Require Project admission before persistence

A manually selected folder becomes a PiLot Project only when canonical Pi resource trust and separate PiLot agent-execution consent are approved together. Existing canonical trust is reused; otherwise admission saves trust even when no trust-requiring resources exist yet, while Project removal revokes execution consent but preserves Pi trust and session history.
