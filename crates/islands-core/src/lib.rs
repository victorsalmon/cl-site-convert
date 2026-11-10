//! Shared runtime support for Rust/Wasm islands.
//!
//! Skeleton only (bead B0.5). An island is componentized *interactive* behaviour
//! extracted from a captured page; it never re-authors page content. This crate
//! exists so the workspace, the `wasm32-unknown-unknown` build and the size
//! budget gate have something real to compile before any island logic lands.

/// Version of the island runtime ABI.
///
/// Bumped whenever the mount-slot contract between an emitter and a compiled
/// island changes.
pub const ABI_VERSION: u16 = 1;

#[cfg(test)]
mod tests {
    use super::ABI_VERSION;

    #[test]
    fn abi_version_starts_at_one() {
        assert_eq!(ABI_VERSION, 1);
    }
}
