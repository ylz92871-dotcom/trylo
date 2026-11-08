use super::*;

fn id(index: u8) -> String { format!("00000000-0000-4000-8000-{index:012}") }
#[test]
fn media_policy_keeps_the_tail_and_rejects_bad_ranges_and_duration() {
    assert_eq!(segment_count(14.0).unwrap(), 3);
    assert_eq!(segment_count(12.03).unwrap(), 2);
    assert!(segment_count(f64::INFINITY).is_err());
    let info = policy::parse_info(br#"{"format":{"duration":"14"},"streams":[{"index":0,"codec_type":"video","disposition":{"attached_pic":1}},{"index":1,"codec_type":"audio"}]}"#).unwrap();
    assert_eq!(info.video_index, None); assert_eq!(info.audio_index, Some(1));
    let manifest = String::from_utf8(policy::playlist(&info).unwrap()).unwrap();
    assert!(manifest.contains("#EXTINF:2.000000,\nsegments/2.ts")); assert!(!manifest.contains("DISCONTINUITY"));
    assert!(policy::byte_ranges("#EXT-X-BYTERANGE:188@0\n#EXT-X-BYTERANGE:376@188\n").is_ok());
    assert!(policy::byte_ranges("#EXT-X-BYTERANGE:188@42\n").is_err());
    let args = policy::stream_arguments(2, &info, std::path::Path::new("owned/index.m3u8"));
    assert!(args.windows(2).any(|pair| pair == ["-output_ts_offset", "13"]));
    assert!(!args.iter().any(|arg| arg == "-t"));
}
#[test]
fn owner_and_early_cancel_are_enforced_before_any_engine_or_file_access() {
    let state = MediaState::new(PathBuf::from("not-used-cache"), PathBuf::from("not-used-engine"));
    state.close(&id(1), "main");
    assert!(state.open(id(1), "not-used-file".into(), "not-used-root".into(), "main").unwrap_err().contains("取消"));
    assert!(state.open(id(2), "not-used-file".into(), "not-used-root".into(), "browser-remote").is_err());
    let request = Request::builder().uri(format!("http://trylo-media.localhost/{}/index.m3u8", id(2))).body(vec![]).unwrap();
    assert_eq!(state.serve(&request, "browser-remote").status(), 403);
    assert_eq!(state.serve(&request, "main").status(), 404);
    state.shutdown(); assert!(state.open(id(3), "not-used-file".into(), "not-used-root".into(), "main").is_err());
}
#[test]
#[ignore = "explicit background FFmpeg fixture acceptance; no UI"]
fn real_media_compatibility_reads_seeks_cancels_and_releases_owned_jobs() {
    use sha2::{Digest, Sha256};
    let engine = PathBuf::from(std::env::var_os("TRYLO_MEDIA_TEST_ENGINE").expect("pinned fixture engine"));
    let fixtures = PathBuf::from(std::env::var_os("TRYLO_MEDIA_TEST_FIXTURES").expect("generated fixture directory"));
    let cache = fixtures.join("native-cache"); let target = fixtures.join("source.mkv");
    let original = Sha256::digest(std::fs::read(&target).unwrap());
    let state = MediaState::new(cache.clone(), engine);
    let opened = state.open(id(4), target.to_string_lossy().into_owned(), fixtures.to_string_lossy().into_owned(), "main").unwrap();
    assert!((opened.info.duration - 14.0).abs() < 0.1);
    assert_eq!(opened.info.video_index, Some(0)); assert_eq!(opened.info.audio_index, Some(1));
    let executables = state.0.engine.get().unwrap();
    for index in [0, 2, 1] {
        let bytes = state.segment(&id(4), index, "main").unwrap(); assert!(!bytes.is_empty());
        let output = fixtures.join(format!("native-piece-{index}.ts")); std::fs::write(&output, bytes.as_ref()).unwrap();
        let parsed = process::probe(&executables.probe, &policy::probe_arguments(), &output, Arc::new(Control::default())).unwrap();
        let data: serde_json::Value = serde_json::from_slice(&parsed).unwrap();
        assert!(data["streams"].as_array().unwrap().iter().any(|stream| stream["codec_name"] == "h264"));
        let args = ["-v", "error", "-nostdin", "-protocol_whitelist", "fd", "-i", "fd:", "-frames:v", "1", "-an", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"].map(str::to_string).to_vec();
        let rgb = process::probe(&executables.encoder, &args, &output, Arc::new(Control::default())).unwrap();
        assert_eq!(rgb.len(), 3); assert!(match index { 0 => rgb[0] > 150 && rgb[2] < 80, 1 => rgb[2] > 150 && rgb[0] < 80, _ => rgb[1] > 80 && rgb[0] < 80 });
    }
    state.close(&id(4), "main"); assert!(state.segment(&id(4), 0, "main").is_err());
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.0.slots.load(Ordering::Acquire) > 0 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
    assert_eq!(state.0.slots.load(Ordering::Acquire), 0);
    assert_eq!(Sha256::digest(std::fs::read(&target).unwrap()), original);
    assert_eq!(std::fs::read_dir(cache).unwrap().count(), 0);
    state.shutdown();
}
#[test]
#[ignore = "explicit background container/codec matrix; no UI"]
fn real_media_matrix_and_distant_seek_use_the_native_service() {
    use sha2::{Digest, Sha256};
    let engine = PathBuf::from(std::env::var_os("TRYLO_MEDIA_TEST_ENGINE").expect("pinned fixture engine"));
    let fixtures = PathBuf::from(std::env::var_os("TRYLO_MEDIA_TEST_FIXTURES").expect("generated fixture directory"));
    let cache = fixtures.join("native-matrix-cache"); let state = MediaState::new(cache.clone(), engine);
    let matrix = fixtures.join("matrix"); let mut cases = 0;
    for (index, entry) in std::fs::read_dir(&matrix).unwrap().enumerate() {
        let target = entry.unwrap().path(); if target.file_name().unwrap() == "source-long.mkv" { continue; }
        let original = Sha256::digest(std::fs::read(&target).unwrap()); let token = id((index + 10) as u8);
        let opened = state.open(token.clone(), target.to_string_lossy().into_owned(), matrix.to_string_lossy().into_owned(), "main").unwrap();
        let encoded = state.segment(&token, 0, "main").unwrap();
        let output = fixtures.join(format!("native-matrix-{index}.ts")); std::fs::write(&output, encoded.as_ref()).unwrap();
        let executable = state.0.engine.get().unwrap().probe;
        let bytes = process::probe(&executable, &policy::probe_arguments(), &output, Arc::new(Control::default())).unwrap();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap(); let streams = data["streams"].as_array().unwrap();
        if opened.info.video_index.is_some() { assert!(streams.iter().any(|stream| stream["codec_name"] == "h264"), "{}", target.display()); }
        if opened.info.audio_index.is_some() { assert!(streams.iter().any(|stream| stream["codec_name"] == "aac"), "{}", target.display()); }
        state.close(&token, "main");
        assert_eq!(Sha256::digest(std::fs::read(&target).unwrap()), original); cases += 1;
    }
    assert!(cases >= 24);
    let token = id(99); let target = matrix.join("source-long.mkv");
    let opened = state.open(token.clone(), target.to_string_lossy().into_owned(), matrix.to_string_lossy().into_owned(), "main").unwrap(); assert!((opened.info.duration - 70.0).abs() < 0.1);
    for index in [0, 9, 0] { assert!(state.segment(&token, index, "main").unwrap().len() > 188); }
    state.close(&token, "main");
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.0.slots.load(Ordering::Acquire) > 0 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
    assert_eq!(state.0.slots.load(Ordering::Acquire), 0); assert_eq!(std::fs::read_dir(cache).unwrap().count(), 0);
}
#[test]
#[ignore = "explicit owned-producer seek race acceptance; no UI"]
fn real_rapid_seeks_cannot_reap_a_newer_owned_producer() {
    let engine = PathBuf::from(std::env::var_os("TRYLO_MEDIA_TEST_ENGINE").expect("pinned fixture engine"));
    let fixtures = PathBuf::from(std::env::var_os("TRYLO_MEDIA_TEST_FIXTURES").expect("fixture directory"));
    let cache = fixtures.join("native-race-cache"); let state = MediaState::new(cache.clone(), engine);
    let source = fixtures.join("matrix/source-long.mkv"); let token = id(98);
    state.open(token.clone(), source.to_string_lossy().into_owned(), fixtures.to_string_lossy().into_owned(), "main").unwrap();
    state.segment(&token, 0, "main").unwrap();
    // A refused request must not become the current seek or cancel playback.
    state.0.requests.store(policy().max_queued_jobs, Ordering::Release);
    assert!(state.segment(&token, 9, "main").unwrap_err().contains("过多"));
    assert_eq!(state.session(&token, "main").unwrap().playback.lock().unwrap().last_request_index, 0);
    state.0.requests.store(0, Ordering::Release);
    let other = state.clone(); let other_token = token.clone();
    let older = std::thread::spawn(move || other.segment(&other_token, 9, "main"));
    let session = state.session(&token, "main").unwrap(); let deadline = Instant::now() + Duration::from_secs(3);
    while session.playback.lock().unwrap().last_request_index != 9 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(1)); }
    assert_eq!(session.playback.lock().unwrap().last_request_index, 9);
    assert!(state.segment(&token, 6, "main").unwrap().len() > 188);
    let _ = older.join().unwrap();
    assert!(state.segment(&token, 7, "main").unwrap().len() > 188);
    state.close(&token, "main");
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.0.slots.load(Ordering::Acquire) > 0 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
    assert_eq!(state.0.slots.load(Ordering::Acquire), 0); assert_eq!(std::fs::read_dir(cache).unwrap().count(), 0);
}
