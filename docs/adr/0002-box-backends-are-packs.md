# Box backends are packs

The backend that creates, starts, and stops boxes is a pack that exports `backend(settings)` through a `box-backend` handler, and a profile selects one. We chose packs over adapters built into the engine so that a team can ship a backend for its own devbox tool from a private pack source, without an engine change. A machine that a person brings needs no backend: `hedge devbox add` reaches it over SSH.
