//! Shared runtime support for Rust/Wasm islands.
//!
//! Skeleton only (bead B0.5, proven by B3.1). An island is componentized
//! *interactive* behaviour extracted from a captured page; it never re-authors
//! page content. This crate exists so the workspace, the `wasm32-unknown-unknown`
//! build and the size budget gate have something real to compile before any
//! island logic lands.
//!
//! # What is exported, and why this is enough for now
//!
//! The crate is built as a plain `cdylib` — **no `wasm-bindgen`** — so the only
//! things the host can call are `#[no_mangle] extern "C"` functions taking and
//! returning scalars. That is a deliberate ceiling at this stage: it proves the
//! compile → `.wasm` → size-gate pipeline without pulling in a bindgen shim and
//! its generated JS glue. When real islands land (Leptos, DOM events, typed
//! props) the switch is `wasm-bindgen` + a **pinned** `wasm-bindgen-cli`
//! (`cargo install --locked wasm-bindgen-cli`) to emit the JS glue and the
//! string/struct marshalling over the Wasm linear memory. See
//! `docs/wasm-build.md` for the measured cost of that switch.
//!
//! # ABI contract
//!
//! The ABI version is the one number an emitter, a host loader and a compiled
//! bundle must agree on. A host that reads a bundle built against a different
//! [`ABI_VERSION`] must refuse to mount it rather than call into it blindly.

/// Version of the island runtime ABI.
///
/// Bumped whenever the mount-slot contract between an emitter and a compiled
/// island changes.
pub const ABI_VERSION: u16 = 1;

/// Returns whether an island bundle can run on a host speaking `host_abi`.
///
/// Refusing loudly is the point: a mismatched host/bundle pair is a build bug,
/// never something to paper over at runtime.
pub fn is_compatible_host_abi(host_abi: u16) -> bool {
    host_abi == ABI_VERSION
}

/// The bundle's ABI version, callable from the host.
///
/// This is the export the mount loader probes before it hands control to the
/// island.
#[no_mangle]
pub extern "C" fn islands_core_abi_version() -> u16 {
    ABI_VERSION
}

/// `1` when this bundle can run on a host speaking `host_abi`, `0` otherwise.
///
/// `u32` rather than `bool` because a `cdylib` boundary without
/// `wasm-bindgen` only carries C scalars.
#[no_mangle]
pub extern "C" fn islands_core_accepts_host_abi(host_abi: u32) -> u32 {
    u32::from(is_compatible_host_abi(host_abi as u16))
}

#[cfg(test)]
mod tests {
    use super::{
        is_compatible_host_abi, islands_core_abi_version, islands_core_accepts_host_abi,
        ABI_VERSION,
    };

    #[test]
    fn abi_version_starts_at_one() {
        assert_eq!(ABI_VERSION, 1);
        assert_eq!(islands_core_abi_version(), ABI_VERSION);
    }

    #[test]
    fn host_abi_must_match_exactly() {
        assert!(is_compatible_host_abi(ABI_VERSION));
        assert!(!is_compatible_host_abi(ABI_VERSION + 1));
        assert!(!is_compatible_host_abi(0));
    }

    #[test]
    fn exported_accepts_host_abi_is_c_abi_friendly() {
        assert_eq!(islands_core_accepts_host_abi(u32::from(ABI_VERSION)), 1);
        assert_eq!(islands_core_accepts_host_abi(999), 0);
    }
}
