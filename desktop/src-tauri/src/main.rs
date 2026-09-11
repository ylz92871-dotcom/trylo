// Trylo Desktop — Rust entry. See the architecture doc §3 Phase 0 Day 1.
//
// The actual Tauri 2 builder lives in lib.rs (the lib+main split is the
// Tauri 2 mobile-friendly pattern). This file just calls into it.

// In release, hide the extra console window on Windows. Keep it in debug
// so we can see `eprintln!` from Rust during the spike.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    trylo_desktop_lib::run();
}
