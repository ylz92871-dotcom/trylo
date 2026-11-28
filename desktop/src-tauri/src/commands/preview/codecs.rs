use tauri::Manager;

/// Read vendor codecs from external installation resources. Keeping them
/// outside embedded frontend assets lets users replace LGPL providers.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Owned values from Tauri IPC.
pub fn preview_codec_paths(app: tauri::AppHandle, provider: String) -> Result<std::collections::HashMap<&'static str, String>, String> {
    let root = std::fs::canonicalize(app.path().resource_dir().map_err(|e| e.to_string())?.join("preview/codecs"))
        .map_err(|_| "预览解码器资源缺失，请修复 Trylo 安装")?;
    let mut paths = std::collections::HashMap::new();
    let files: &[(&str, &str)] = match provider.as_str() {
        "tiff" => &[("tiffPako", "tiff/pako.min.js"), ("tiffUtif", "tiff/UTIF.js")],
        "heif" => &[("heif", "heif/libheif-bundle.js")],
        "cad" => &[("cad", "cad/occt-import-js.js"), ("cadWasm", "cad/occt-import-js.wasm")],
        "archive" => &[("archive", "archive/libarchive.js"), ("archiveWasm", "archive/libarchive.wasm")],
        _ => return Err("未知预览解码器".into()),
    };
    for &(name, file) in files {
        let target = std::fs::canonicalize(root.join(file)).map_err(|_| format!("预览解码器文件缺失：{file}"))?;
        if !target.starts_with(&root) || !target.is_file() { return Err("预览解码器路径无效".into()); }
        paths.insert(name, target.to_string_lossy().into_owned());
    }
    Ok(paths)
}
