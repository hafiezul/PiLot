# Preserve bidirectional CLI session continuity

PiLot tasks will use standard Pi session files so work can be resumed from either PiLot or the Pi CLI when their session-schema versions are compatible. PiLot-specific task metadata will be stored as namespaced `custom` entries, which remain outside model context and do not prevent the CLI from reading or extending the session; unknown newer schemas must be gated rather than rewritten.
