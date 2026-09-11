// Tauri 2 build script. Generates the Tauri-side context (capabilities,
// generated TypeScript bindings) at compile time. No custom logic needed
// for the spike.

fn main() {
    tauri_build::build();
}
