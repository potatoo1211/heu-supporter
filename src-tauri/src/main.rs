#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Write, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;
use std::thread;
use std::time::Duration;
use tauri::Manager;

#[derive(Serialize)]
struct TestCaseResult {
    id: usize,
    score: i64,
    status: String,
    time: f64,
    error_msg: String,
}

#[derive(Serialize)]
struct VisualizerData {
    html: String,
    input: String,
    output: String,
    web_url: Option<String>,
    local_url: Option<String>,
}

#[derive(Serialize)]
struct ContestItem {
    name: String,
    updated_at: u64,
}

fn find_tools_dir(contest_dir: &Path) -> PathBuf {
    let direct_tools = contest_dir.join("tools");
    if direct_tools.exists() { return direct_tools; }
    if let Ok(entries) = fs::read_dir(contest_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                let nested_tools = entry.path().join("tools");
                if nested_tools.exists() { return nested_tools; }
            }
        }
    }
    contest_dir.to_path_buf()
}

fn escape_html_for_srcdoc(html: &str) -> String {
    html.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;")
}

#[tauri::command]
fn get_contests() -> Result<Vec<ContestItem>, String> {
    let mut contests = Vec::new();
    let base_dir = std::env::current_dir().unwrap().join("workspaces");

    if base_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(base_dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|f| f.is_dir()).unwrap_or(false) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    
                    // フォルダの最終更新日時を取得（取得失敗時は現在時刻）
                    let updated_at = entry.metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::SystemTime::now())
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    contests.push(ContestItem { name, updated_at });
                }
            }
        }
    }
    
    Ok(contests)
}

#[tauri::command]
async fn create_contest(name: String, zip_path: String, optimize_target: String, variables: String) -> Result<String, String> {
    let target_dir = Path::new("./workspaces").join(&name);
    if target_dir.exists() { return Err("既に同じ名前が存在します".to_string()); }

    let file = fs::File::open(&zip_path).map_err(|e| format!("ファイルが開けません: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("ZIP読込失敗: {}", e))?;
    fs::create_dir_all(&target_dir).map_err(|e| format!("ディレクトリ作成失敗: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() { Some(p) => target_dir.join(p), None => continue };
        if (*file.name()).ends_with('/') { fs::create_dir_all(&outpath).map_err(|e| e.to_string())?; } 
        else {
            if let Some(p) = outpath.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
            io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    // コンテスト設定をconfig.jsonとして保存
    let config = ContestConfig {
        name: name.clone(),
        tools_dir: target_dir.to_string_lossy().to_string(),
        optimize_target,
        variables,
    };
    let config_path = target_dir.join("config.json");
    let config_json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, config_json).map_err(|e| e.to_string())?;

    Ok(format!("コンテスト '{}' を作成しました！", name))
}

#[tauri::command]
async fn delete_contest(name: String) -> Result<String, String> {
    let target_dir = Path::new("./workspaces").join(&name);
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir).map_err(|e| format!("削除失敗: {}", e))?;
        Ok(format!("{} を削除しました", name))
    } else {
        Err("コンテストが見つかりません".to_string())
    }
}

#[tauri::command]
async fn save_submissions(contest_name: String, data: String) -> Result<(), String> {
    let base_dir = std::env::current_dir().unwrap();
    let file_path = base_dir.join("workspaces").join(&contest_name).join("submissions.json");
    fs::write(file_path, data).map_err(|e| format!("保存失敗: {}", e))
}

#[tauri::command]
async fn load_submissions(contest_name: String) -> Result<String, String> {
    let base_dir = std::env::current_dir().unwrap();
    let file_path = base_dir.join("workspaces").join(&contest_name).join("submissions.json");
    if file_path.exists() {
        fs::read_to_string(file_path).map_err(|e| format!("読込失敗: {}", e))
    } else {
        Ok("[]".to_string())
    }
}

#[tauri::command]
async fn get_visualizer_data(contest_name: String, case_id: usize, submission_id: Option<String>) -> Result<VisualizerData, String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    let tools_dir = find_tools_dir(&contest_dir);
    let exe_suffix = std::env::consts::EXE_SUFFIX;

    let in_file = tools_dir.join("in").join(format!("{:04}.txt", case_id));

    // per-submission ファイルを優先、なければ共通 out/ にフォールバック
    let out_file = if let Some(ref sid) = submission_id {
        let sub_path = contest_dir.join("out").join(sid).join(format!("{:04}.txt", case_id));
        if sub_path.exists() { sub_path } else { contest_dir.join("out").join(format!("{:04}.txt", case_id)) }
    } else {
        contest_dir.join("out").join(format!("{:04}.txt", case_id))
    };

    if !out_file.exists() { return Err("出力ファイルが存在しません。".to_string()); }

    let input_text = fs::read_to_string(&in_file).unwrap_or_default();
    let output_text = fs::read_to_string(&out_file).unwrap_or_default();

    let mut web_url = None;
    if let Ok(readme) = fs::read_to_string(tools_dir.join("README.md")) {
        let mut current_idx = 0;
        while let Some(start) = readme[current_idx..].find("https://img.atcoder.jp/") {
            let actual_start = current_idx + start;
            let end = readme[actual_start..].find(|c: char| c.is_whitespace() || c == ')' || c == '"').unwrap_or(readme[actual_start..].len());
            let url = &readme[actual_start..actual_start + end];
            if url.contains(".html") { web_url = Some(url.to_string()); break; }
            current_idx = actual_start + end;
        }
    }

    let mut html = String::new();
    let mut local_url = None;

    if let Some(url) = &web_url {
        let url_without_query = url.split('?').next().unwrap_or(url);
        let base_url = url_without_query.rsplit('/').skip(1).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/") + "/";
        let file_name = url_without_query.split('/').last().unwrap_or("");
        let prefix = file_name.replace(".html", "");

        let web_vis_dir = tools_dir.join("web_vis");
        fs::create_dir_all(&web_vis_dir).unwrap_or_default();
        let index_html_path = web_vis_dir.join("index.html");
        
        // ★ テンプレートHTMLのパス
        let template_html_path = web_vis_dir.join("template.html");

        let js_path = web_vis_dir.join(format!("{}.js", prefix));
        let wasm_path = web_vis_dir.join(format!("{}_bg.wasm", prefix));
        let css_path = web_vis_dir.join("style.css");

        // JS/WASM/CSS のダウンロード（初回のみ）
        if !js_path.exists() { if let Ok(resp) = reqwest::get(format!("{}{}.js", base_url, prefix)).await { if let Ok(b) = resp.bytes().await { let _ = fs::write(&js_path, b); } } }
        if !wasm_path.exists() { if let Ok(resp) = reqwest::get(format!("{}{}_bg.wasm", base_url, prefix)).await { if let Ok(b) = resp.bytes().await { let _ = fs::write(&wasm_path, b); } } }
        if !css_path.exists() { if let Ok(resp) = reqwest::get(format!("{}style.css", base_url)).await { if let Ok(b) = resp.bytes().await { let _ = fs::write(&css_path, b); } } }

        // ★ HTML本体も初回のみダウンロードして保存。2回目以降は超高速＆完全オフライン！
        let mut base_html_text = String::new();
        if template_html_path.exists() {
            base_html_text = fs::read_to_string(&template_html_path).unwrap_or_default();
        } else if let Ok(response) = reqwest::get(url).await {
            if let Ok(mut text) = response.text().await {
                let base_tag = format!("<base href=\"{}\">", base_url);
                if let Some(head_idx) = text.find("<head>") {
                    text.insert_str(head_idx + 6, &base_tag);
                } else {
                    text.insert_str(0, &format!("<head>{}</head>", base_tag));
                }
                let _ = fs::write(&template_html_path, &text);
                base_html_text = text;
            }
        }

        if !base_html_text.is_empty() {
            // HTMLの中にあるAtCoderの直リンクを、すべてローカルのプロキシ経由にすり替える
            let mut base_html_text = base_html_text.replace("https://img.atcoder.jp/", "http://127.0.0.1:14234/proxy/");
            
            let safe_in = input_text.replace("</script>", "<\\/script>");
            let safe_out = output_text.replace("</script>", "<\\/script>");

            let inject_script = format!(r#"
<script type="text/plain" id="my_in_data">{}</script>
<script type="text/plain" id="my_out_data">{}</script>
<script>
// 不要なUI要素を削除（問題文リンク・使い方・Detailsブロック）
const removeClutter = () => {{
    // <details> 要素をすべて削除
    document.querySelectorAll('details').forEach(el => el.remove());
    // テキストノードに「問題文はこちら」「使い方」を含む要素を削除
    const walk = (node) => {{
        if (node.nodeType === Node.ELEMENT_NODE) {{
            const text = node.innerText || '';
            if (/問題文はこちら|使い方/.test(text) && node.tagName !== 'BODY' && node.tagName !== 'HTML') {{
                // 子孫に textarea/canvas/svg が無ければ削除
                if (!node.querySelector('textarea, canvas, svg, input')) {{
                    node.remove();
                    return;
                }}
            }}
            Array.from(node.children).forEach(walk);
        }}
    }};
    walk(document.body);
}};

const applyData = (inStr, outStr, seedValue) => {{
    const textareas = document.querySelectorAll('textarea');
    if (textareas.length >= 2) {{
        const setNativeValue = (element, value) => {{
            const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
            const prototypeValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
            if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {{ prototypeValueSetter.call(element, value);
            }} else if (valueSetter) {{ valueSetter.call(element, value);
            }} else {{ element.value = value; }}
            element.dispatchEvent(new Event('input', {{ bubbles: true }}));
            element.dispatchEvent(new Event('change', {{ bubbles: true }}));
        }};
        
        // InputとOutputの書き換え
        setNativeValue(textareas[0], inStr);
        setNativeValue(textareas[1], outStr);
        
        // Seed欄の書き換え
        const seedInput = document.getElementById('seed');
        if (seedInput) {{
            setNativeValue(seedInput, seedValue);
        }}
        
        // 自動再生はしない（ユーザーが▶を押すまで待つ）
        
        return true;
    }}
    return false;
}};

window.addEventListener('load', () => {{
    // 不要UI削除（DOMが安定してから少し待つ）
    setTimeout(removeClutter, 300);

    let attempts = 0;
    const tryInject = setInterval(() => {{
        attempts++;
        const inStr = document.getElementById('my_in_data').textContent.replace(/<\\\/script>/g, '<' + '/script>');
        const outStr = document.getElementById('my_out_data').textContent.replace(/<\\\/script>/g, '<' + '/script>');
        if (applyData(inStr, outStr, "{}")) {{ clearInterval(tryInject); }}
        else if (attempts > 50) {{ clearInterval(tryInject); }}
    }}, 100);
}});

window.addEventListener('message', (event) => {{
    if (event.data && event.data.type === 'UPDATE_VIS') {{
        applyData(event.data.input, event.data.output, event.data.seed);
    }}
}});
</script>
"#, safe_in, safe_out, case_id);

            let mut final_html = base_html_text;
            if let Some(body_idx) = final_html.rfind("</body>") {
                final_html.insert_str(body_idx, &inject_script);
            } else {
                final_html.push_str(&inject_script);
            }
            fs::write(&index_html_path, final_html).unwrap_or_default();

            let relative_tools = tools_dir.strip_prefix(&base_dir.join("workspaces")).unwrap();
            let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
            local_url = Some(format!("http://127.0.0.1:14234/{}/web_vis/index.html", relative_tools.to_string_lossy().replace("\\", "/")));
        }
    }

    if local_url.is_none() {
        let vis_bin = tools_dir.join("target").join("release").join(format!("vis{}", exe_suffix));
        let output = if vis_bin.exists() {
            Command::new(&vis_bin).current_dir(&tools_dir).args([in_file.to_str().unwrap(), out_file.to_str().unwrap()]).output()
        } else {
            Command::new("cargo").current_dir(&tools_dir).args(["run", "--release", "--bin", "vis", "--", in_file.to_str().unwrap(), out_file.to_str().unwrap()]).output()
        };

        if let Ok(o) = output {
            let vis_html = tools_dir.join("vis.html");
            if vis_html.exists() {
                html = fs::read_to_string(vis_html).unwrap_or_default();
            } else {
                let stdout_str = String::from_utf8_lossy(&o.stdout);
                if stdout_str.contains("<svg") {
                    html = format!("<html><body style=\"margin:0;display:flex;justify-content:center;align-items:center;\">{}</body></html>", stdout_str);
                } else {
                    return Err("vis.htmlが生成されませんでした。".to_string());
                }
            }
            // HTMLの中にあるAtCoderの直リンクを、すべてローカルのプロキシ経由にすり替える
            html = html.replace("https://img.atcoder.jp/", "http://127.0.0.1:14234/proxy/");
        } else {
            return Err("visツールの実行に失敗しました。".to_string());
        }
        html = format!("<iframe srcdoc=\"{}\" style=\"width:100%; height:100vh; border:none; min-height:800px;\"></iframe>", escape_html_for_srcdoc(&html));
    }

    Ok(VisualizerData { html, input: input_text, output: output_text, web_url, local_url })
}

#[tauri::command]
async fn generate_inputs(contest_name: String, test_cases: usize) -> Result<String, String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    let tools_dir = find_tools_dir(&contest_dir);

    let seeds_path = tools_dir.join("seeds.txt");
    let mut seeds_file = fs::File::create(&seeds_path).map_err(|e| e.to_string())?;
    for i in 0..test_cases { writeln!(seeds_file, "{}", i).map_err(|e| e.to_string())?; }

    let output = Command::new("cargo").env_remove("CARGO_TARGET_DIR").current_dir(&tools_dir).args(&["run", "--release", "--bin", "gen", "seeds.txt"]).output().map_err(|e| format!("gen起動失敗: {}", e))?;
    if !output.status.success() { return Err(format!("生成エラー:\n{}", String::from_utf8_lossy(&output.stderr))); }
    Ok(format!("{} 個のテストケース生成完了！", test_cases))
}

#[tauri::command]
async fn setup_submission(contest_name: String, code: String, language: String, test_cases: usize) -> Result<String, String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    let tools_dir = find_tools_dir(&contest_dir);
    let exe_suffix = std::env::consts::EXE_SUFFIX;
    
    let file_ext = if language == "cpp" { "cpp" } else { "py" };
    let src_path = contest_dir.join(format!("main.{}", file_ext));
    fs::write(&src_path, &code).map_err(|e| format!("保存失敗: {}", e))?;

    let exe_path = contest_dir.join(format!("a.out{}", exe_suffix));
    if language == "cpp" {
        let output = Command::new("g++").args(["-O3", src_path.to_str().unwrap(), "-o", exe_path.to_str().unwrap()]).output().map_err(|e| format!("コンパイル起動失敗: {}", e))?;
        if !output.status.success() { return Err(format!("【コンパイルエラー】\n{}", String::from_utf8_lossy(&output.stderr))); }
    }

    let build_output = Command::new("cargo").env_remove("CARGO_TARGET_DIR").current_dir(&tools_dir).args(["build", "--release"]).output().map_err(|e| format!("ツール群のビルド起動失敗: {}", e))?;
    if !build_output.status.success() { return Err(format!("ツールビルドエラー:\n{}", String::from_utf8_lossy(&build_output.stderr))); }

    let in_dir = tools_dir.join("in");
    fs::create_dir_all(&in_dir).unwrap_or_default();
    let is_missing = (0..test_cases).any(|i| !in_dir.join(format!("{:04}.txt", i)).exists());

    if is_missing {
        let seeds_path = tools_dir.join("seeds.txt");
        if let Ok(mut seeds_file) = fs::File::create(&seeds_path) {
            for i in 0..test_cases { let _ = writeln!(seeds_file, "{}", i); }
        }
        let _ = Command::new("cargo").env_remove("CARGO_TARGET_DIR").current_dir(&tools_dir).args(&["run", "--release", "--bin", "gen", "seeds.txt"]).output();
    }
    Ok("準備完了".to_string())
}

#[tauri::command]
async fn run_test_case(contest_name: String, language: String, case_id: usize, time_limit: f64, memory_limit: usize, submission_id: String) -> Result<TestCaseResult, String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    let tools_dir = find_tools_dir(&contest_dir);
    let exe_suffix = std::env::consts::EXE_SUFFIX;

    let file_ext = if language == "cpp" { "cpp" } else { "py" };
    let src_path = contest_dir.join(format!("main.{}", file_ext));
    let exe_path = contest_dir.join(format!("a.out{}", exe_suffix));

    let out_dir = contest_dir.join("out");
    fs::create_dir_all(&out_dir).unwrap_or_default();
    // 提出ごとのサブディレクトリも作成
    let sub_out_dir = out_dir.join(&submission_id);
    fs::create_dir_all(&sub_out_dir).unwrap_or_default();
    let in_dir = tools_dir.join("in");

    let in_file = in_dir.join(format!("{:04}.txt", case_id));
    let out_file = sub_out_dir.join(format!("{:04}.txt", case_id));
    let err_file = sub_out_dir.join(format!("{:04}_err.txt", case_id));

    if !in_file.exists() { return Ok(TestCaseResult { id: case_id, score: 0, status: "IE".to_string(), time: 0.0, error_msg: "入力ファイル生成エラー".to_string() }); }

    let tester_bin = tools_dir.join("target").join("release").join(format!("tester{}", exe_suffix));
    let use_tester = tester_bin.exists();

    let mut last_result = TestCaseResult { id: case_id, score: 0, status: "IE".to_string(), time: 0.0, error_msg: "Unknown".to_string() };

    for attempt in 1..=3 {
        #[cfg(unix)]
        let mut cmd = {
            let kb = memory_limit * 1024;
            let user_cmd = if language == "cpp" { format!("ulimit -v {}; exec \"{}\"", kb, exe_path.to_str().unwrap()) } else { format!("ulimit -v {}; exec python3 \"{}\"", kb, src_path.to_str().unwrap()) };
            if use_tester { let mut c = Command::new(&tester_bin); c.arg("sh").arg("-c").arg(&user_cmd); c } 
            else { let mut c = Command::new("sh"); c.arg("-c").arg(&user_cmd); c }
        };

        #[cfg(not(unix))]
        let mut cmd = {
            if use_tester { let mut c = Command::new(&tester_bin); if language == "cpp" { c.arg(&exe_path); } else { c.arg("python3").arg(&src_path); } c } 
            else { if language == "cpp" { Command::new(&exe_path) } else { let mut py = Command::new("python3"); py.arg(&src_path); py } }
        };

        let input_file_handle = match fs::File::open(&in_file) { Ok(f) => f, Err(e) => return Ok(TestCaseResult { id: case_id, score: 0, status: "RE".to_string(), time: 0.0, error_msg: e.to_string() }) };
        let output_file_handle = fs::File::create(&out_file).unwrap();
        let error_file_handle = fs::File::create(&err_file).unwrap();

        cmd.stdin(Stdio::from(input_file_handle)).stdout(Stdio::from(output_file_handle)).stderr(Stdio::from(error_file_handle));

        let start_time = Instant::now();
        let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => return Ok(TestCaseResult { id: case_id, score: 0, status: "RE".to_string(), time: 0.0, error_msg: e.to_string() }) };

        let mut is_tle = false;
        let mut exit_status_opt = None;

        loop {
            match child.try_wait() {
                Ok(Some(exit_status)) => { exit_status_opt = Some(exit_status); break; }
                Ok(None) => {
                    if start_time.elapsed().as_secs_f64() > time_limit { let _ = child.kill(); let _ = child.wait(); is_tle = true; break; }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => { return Ok(TestCaseResult { id: case_id, score: 0, status: "IE".to_string(), time: start_time.elapsed().as_secs_f64(), error_msg: format!("監視エラー: {}", e) }); }
            }
        }

        let exec_time = start_time.elapsed().as_secs_f64();

        if is_tle {
            last_result = TestCaseResult { id: case_id, score: 0, status: "TLE".to_string(), time: exec_time, error_msg: if attempt < 3 { format!("TLE ({:.2}s) - {}回目の再ジャッジを実行中...", time_limit, attempt + 1) } else { format!("TLE ({:.2}s)", time_limit) } };
            if attempt < 3 { continue; } else { break; }
        }

        let err_msg = fs::read_to_string(&err_file).unwrap_or_default();
        if let Some(exit_status) = exit_status_opt {
            if !exit_status.success() {
                let is_mle = err_msg.contains("MemoryError") || err_msg.contains("bad allocation") || exit_status.code() == Some(137) || exit_status.code() == Some(139);
                if !is_mle && err_msg.contains("Score =") { } else {
                    let status = if is_mle { "MLE" } else { "RE" };
                    last_result = TestCaseResult { id: case_id, score: 0, status: status.to_string(), time: exec_time, error_msg: format!("{}\n(Exit Code: {:?})", err_msg.trim(), exit_status.code()) };
                    break;
                }
            }
        }

        let vis_bin = tools_dir.join("target").join("release").join(format!("vis{}", exe_suffix));
        let mut combined = err_msg.clone();

        if vis_bin.exists() {
            if let Ok(vo) = Command::new(&vis_bin).current_dir(&tools_dir).args([in_file.to_str().unwrap(), out_file.to_str().unwrap()]).output() {
                if vo.status.success() { combined = format!("{}\n{}\n{}", combined, String::from_utf8_lossy(&vo.stdout), String::from_utf8_lossy(&vo.stderr)); }
            }
        }

        let mut score = 0;
        if let Some(idx) = combined.rfind("Score = ") {
            let sub = &combined[idx + 8..];
            let num_str = sub.split_whitespace().next().unwrap_or("0");
            score = num_str.parse::<i64>().unwrap_or(0);
        }

        if score > 0 { last_result = TestCaseResult { id: case_id, score, status: "AC".to_string(), time: exec_time, error_msg: "".to_string() }; } 
        else { last_result = TestCaseResult { id: case_id, score: 0, status: "WA".to_string(), time: exec_time, error_msg: combined.to_string() }; }
        break; 
    }

    Ok(last_result)
}

#[tauri::command]
fn resize_window(window: tauri::WebviewWindow, width: f64, height: f64) {
    let target_width = width * 0.9;
    let target_height = height * 0.9;
    let _ = window.set_size(tauri::LogicalSize::new(target_width, target_height));
    let _ = window.center();
    let _ = window.show();
}

#[tauri::command]
async fn get_testcase_memos(contest_name: String) -> Result<HashMap<String, String>, String> {
    let base_dir = std::env::current_dir().unwrap();
    let memos_file = base_dir.join("workspaces").join(&contest_name).join("memos.json");
    
    if memos_file.exists() {
        let content = fs::read_to_string(memos_file).unwrap_or_else(|_| "{}".to_string());
        let memos: HashMap<String, String> = serde_json::from_str(&content).unwrap_or_default();
        Ok(memos)
    } else {
        Ok(HashMap::new())
    }
}

#[tauri::command]
async fn save_testcase_memo(contest_name: String, case_id: usize, memo: String) -> Result<(), String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    let memos_file = contest_dir.join("memos.json");

    let mut memos: HashMap<String, String> = if memos_file.exists() {
        let content = fs::read_to_string(&memos_file).unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    };

    memos.insert(case_id.to_string(), memo);

    let json = serde_json::to_string_pretty(&memos).map_err(|e| e.to_string())?;
    fs::write(memos_file, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
struct ContestConfig {
    name: String,
    tools_dir: String,
    optimize_target: String,
    variables: String,
}

impl Default for ContestConfig {
    fn default() -> Self {
        Self {
            name: "".to_string(),
            tools_dir: "".to_string(),
            optimize_target: "maximize".to_string(),
            variables: "".to_string(),
        }
    }
}

#[tauri::command]
async fn get_contest_config(contest_name: String) -> Result<ContestConfig, String> {
    let base_dir = std::env::current_dir().unwrap();
    let config_file = base_dir.join("workspaces").join(&contest_name).join("config.json");

    if config_file.exists() {
        let content = fs::read_to_string(config_file).unwrap_or_else(|_| "{}".to_string());
        let mut config: ContestConfig = serde_json::from_str(&content).unwrap_or_default();
        config.name = contest_name.clone();
        Ok(config)
    } else {
        let mut config = ContestConfig::default();
        config.name = contest_name;
        Ok(config)
    }
}

#[tauri::command]
async fn save_contest_config(contest_name: String, config: ContestConfig) -> Result<(), String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    
    if !contest_dir.exists() {
        fs::create_dir_all(&contest_dir).map_err(|e| format!("ディレクトリ作成失敗: {}", e))?
    }
    
    let config_file = contest_dir.join("config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_file, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_testcase_variables(contest_name: String) -> Result<HashMap<usize, HashMap<String, f64>>, String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    
    let config_file = contest_dir.join("config.json");
    let config: ContestConfig = if config_file.exists() {
        let content = fs::read_to_string(&config_file).unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        return Ok(HashMap::new());
    };

    let var_names: Vec<&str> = config.variables.split_whitespace().collect();
    if var_names.is_empty() {
        return Ok(HashMap::new());
    }

    let tools_dir = find_tools_dir(&contest_dir);
    let in_dir = tools_dir.join("in");
    if !in_dir.exists() {
        return Ok(HashMap::new());
    }

    let mut result = HashMap::new();

    if let Ok(entries) = fs::read_dir(in_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("txt") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if let Ok(case_id) = stem.parse::<usize>() {
                        if let Ok(file) = File::open(&path) {
                            let mut reader = BufReader::new(file);
                            let mut first_line = String::new();
                            
                            if reader.read_line(&mut first_line).is_ok() {
                                let values: Vec<&str> = first_line.split_whitespace().collect();
                                let mut var_map = HashMap::new();
                                
                                for (i, name) in var_names.iter().enumerate() {
                                    if let Some(val_str) = values.get(i) {
                                        if let Ok(val) = val_str.parse::<f64>() {
                                            var_map.insert(name.to_string(), val);
                                        }
                                    }
                                }
                                result.insert(case_id, var_map);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command]
async fn update_tools_from_zip(contest_name: String, zip_path: String) -> Result<(), String> {
    let base_dir = std::env::current_dir().unwrap();
    let contest_dir = base_dir.join("workspaces").join(&contest_name);
    
    if !contest_dir.exists() {
        return Err("コンテストディレクトリが存在しません".to_string());
    }

    let file = fs::File::open(&zip_path).map_err(|e| format!("ファイルが開けません: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("ZIP読込失敗: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() { Some(p) => contest_dir.join(p), None => continue };
        if (*file.name()).ends_with('/') { fs::create_dir_all(&outpath).map_err(|e| e.to_string())?; } 
        else {
            if let Some(p) = outpath.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
            io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
fn rename_contest(old_name: String, new_name: String) -> Result<(), String> {
    if old_name == new_name {
        return Ok(());
    }

    let base_dir = std::env::current_dir().unwrap().join("workspaces");
    let old_dir = base_dir.join(&old_name);
    let new_dir = base_dir.join(&new_name);

    if !old_dir.exists() {
        return Err("元のコンテストが存在しません".to_string());
    }
    if new_dir.exists() {
        return Err("新しい名前のコンテストが既に存在します".to_string());
    }

    // 1. フォルダ名を変更する
    std::fs::rename(&old_dir, &new_dir).map_err(|e| e.to_string())?;

    // 2. config.json の中の "name" も書き換える
    let config_path = new_dir.join("config.json");
    if config_path.exists() {
        if let Ok(config_str) = std::fs::read_to_string(&config_path) {
            // どんな構造体でもパースできるように汎用JSONオブジェクト(Value)として読み込む
            if let Ok(mut config_json) = serde_json::from_str::<serde_json::Value>(&config_str) {
                config_json["name"] = serde_json::json!(new_name);
                if let Ok(new_config_str) = serde_json::to_string_pretty(&config_json) {
                    let _ = std::fs::write(&config_path, new_config_str);
                }
            }
        }
    }

    Ok(())
}

fn main() {
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
    }

    std::thread::spawn(|| {
        if let Ok(server) = tiny_http::Server::http("127.0.0.1:14234") {
            let base_dir = std::env::current_dir().unwrap().join("workspaces");
            for request in server.incoming_requests() {
                let url = request.url().split('?').next().unwrap().trim_start_matches('/');
                
                // --- ↓ ここからプロキシ（身代わり）処理を追加 ↓ ---
                if url.starts_with("proxy/") {
                    // 1. ローカルのURLをAtCoderの本来のURLに復元する
                    let target_url = format!("https://img.atcoder.jp/{}", &url[6..]);

                    // 2. Rust側でAtCoderからファイルをダウンロード（CORS制限を受けない！）
                    if let Ok(resp) = reqwest::blocking::get(&target_url) {
                        let content_type = if target_url.ends_with(".wasm") {
                            "application/wasm"
                        } else if target_url.ends_with(".js") {
                            "application/javascript; charset=utf-8"
                        } else {
                            "text/plain"
                        };

                        let mut bytes = resp.bytes().unwrap_or_default().to_vec();

                        // 3. JSファイルの中身に直接AtCoderのURLが書かれている場合、それもプロキシURLに書き換える
                        if target_url.ends_with(".js") {
                            if let Ok(js_text) = String::from_utf8(bytes.clone()) {
                                let modified_js = js_text.replace("https://img.atcoder.jp/", "http://127.0.0.1:14234/proxy/");
                                bytes = modified_js.into_bytes();
                            }
                        }

                        // 4. ブラウザに「安全なローカルファイルですよ」と偽装して返す
                        let response = tiny_http::Response::from_data(bytes)
                            .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap());
                        
                        let _ = request.respond(response);
                    } else {
                        let _ = request.respond(tiny_http::Response::new_empty(tiny_http::StatusCode(404)));
                    }
                    continue;
                }
                // --- ↑ プロキシ処理ここまで ↑ ---

                let file_path = base_dir.join(url);

                if file_path.exists() && file_path.is_file() {
                    if let Ok(file) = std::fs::File::open(&file_path) {
                        let mut response = tiny_http::Response::from_file(file);
                        
                        if url.ends_with(".html") {
                            response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                            response.add_header(tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store, no-cache, max-age=0"[..]).unwrap());
                        } else if url.ends_with(".js") {
                            response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/javascript; charset=utf-8"[..]).unwrap());
                        } else if url.ends_with(".wasm") {
                            response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/wasm"[..]).unwrap());
                        } else if url.ends_with(".css") {
                            response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/css; charset=utf-8"[..]).unwrap());
                        }
                        
                        let _ = request.respond(response);
                        continue;
                    }
                }
                let response = tiny_http::Response::new_empty(tiny_http::StatusCode(404));
                let _ = request.respond(response);
            }
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_visualizer_data,
            get_contests,
            create_contest,
            delete_contest,
            save_submissions,
            load_submissions,
            generate_inputs,
            setup_submission,
            run_test_case,
            resize_window,
            get_testcase_memos,
            save_testcase_memo,
            get_contest_config,
            save_contest_config,
            get_testcase_variables,
            update_tools_from_zip,
            rename_contest
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}