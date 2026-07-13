# Update Pi only with PiLot releases

PiLot will update its pinned Pi SDK only through tested, signed application releases. It will neither update the runtime independently nor fall back to spawning a newer global CLI; session files using an unsupported newer schema will be left untouched and require a PiLot update.
