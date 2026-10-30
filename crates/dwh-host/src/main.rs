//! Local framed JSON-RPC host for Electron (Unix socket / TCP loopback).
//!
//! Prints one of:
//!   `DWH_HOST_READY unix <path>`
//!   `DWH_HOST_READY tcp <port>`
//! on stdout when listening.
//!
//! Frame: u32 LE length + UTF-8 JSON
//!   req:  {"id":1,"cmd":"preview_workspace","args":{...}}
//!   resp: {"id":1,"ok":true,"result":...} | {"id":1,"ok":false,"error":"..."}
//!
//! Most commands run on the accept thread. `llm_chat` runs on a worker thread so
//! DuckDB/preview RPCs are not blocked by the HTTP wait (Electron correlates by id).

use dwh_host::{configure_paths, HostState};
use serde::Deserialize;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

#[derive(Deserialize)]
struct RpcRequest {
    #[serde(default)]
    id: Option<u64>,
    cmd: String,
    #[serde(default)]
    args: serde_json::Value,
}

fn main() {
    configure_paths();
    let state = match HostState::new() {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("[dwh-host] failed to start DuckDB session: {e}");
            std::process::exit(1);
        }
    };

    match bind_listener() {
        Ok(Listener::Unix { listener, path }) => {
            println!("DWH_HOST_READY unix {}", path.display());
            let _ = std::io::Write::flush(&mut std::io::stdout());
            eprintln!("[dwh-host] listening on unix {}", path.display());
            #[cfg(unix)]
            serve_unix(listener, path, state);
            #[cfg(not(unix))]
            {
                let _ = (listener, path, state);
                unreachable!();
            }
        }
        Ok(Listener::Tcp { listener, port }) => {
            println!("DWH_HOST_READY tcp {port}");
            let _ = std::io::Write::flush(&mut std::io::stdout());
            eprintln!("[dwh-host] listening on tcp://127.0.0.1:{port}");
            serve_tcp(listener, state);
        }
        Err(e) => {
            eprintln!("[dwh-host] bind failed: {e}");
            std::process::exit(1);
        }
    }
}

enum Listener {
    #[cfg_attr(not(unix), allow(dead_code))]
    Unix {
        #[cfg(unix)]
        listener: UnixListener,
        #[cfg(not(unix))]
        listener: (),
        path: PathBuf,
    },
    Tcp {
        listener: TcpListener,
        port: u16,
    },
}

fn bind_listener() -> Result<Listener, String> {
    #[cfg(unix)]
    {
        if std::env::var_os("DWH_HOST_TCP").is_none() {
            let dir = std::env::var_os("XDG_RUNTIME_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let path = dir.join(format!("dwh-host-{}.sock", std::process::id()));
            let _ = std::fs::remove_file(&path);
            match UnixListener::bind(&path) {
                Ok(listener) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                    }
                    return Ok(Listener::Unix { listener, path });
                }
                Err(e) => {
                    eprintln!("[dwh-host] unix bind failed ({e}), falling back to tcp");
                }
            }
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(Listener::Tcp { listener, port })
}

#[cfg(unix)]
fn serve_unix(listener: UnixListener, path: PathBuf, state: Arc<HostState>) {
    struct SockGuard(PathBuf);
    impl Drop for SockGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _guard = SockGuard(path);

    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let st = Arc::clone(&state);
                if let Err(e) = handle_clonable_stream(stream, st) {
                    eprintln!("[dwh-host] client error: {e}");
                }
            }
            Err(e) => eprintln!("[dwh-host] accept error: {e}"),
        }
    }
}

fn serve_tcp(listener: TcpListener, state: Arc<HostState>) {
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                let st = Arc::clone(&state);
                if let Err(e) = handle_clonable_stream(stream, st) {
                    eprintln!("[dwh-host] client error: {e}");
                }
            }
            Err(e) => eprintln!("[dwh-host] accept error: {e}"),
        }
    }
}

trait ClonableStream: Read + Write + Send + 'static {
    fn try_clone_stream(&self) -> std::io::Result<Self>
    where
        Self: Sized;
}

impl ClonableStream for TcpStream {
    fn try_clone_stream(&self) -> std::io::Result<Self> {
        self.try_clone()
    }
}

#[cfg(unix)]
impl ClonableStream for UnixStream {
    fn try_clone_stream(&self) -> std::io::Result<Self> {
        self.try_clone()
    }
}

fn handle_clonable_stream<S: ClonableStream>(stream: S, state: Arc<HostState>) -> Result<(), String> {
    let writer = Arc::new(Mutex::new(
        stream
            .try_clone_stream()
            .map_err(|e| format!("clone stream for async replies: {e}"))?,
    ));
    let mut reader = stream;
    loop {
        let body = match read_frame(&mut reader) {
            Ok(b) => b,
            Err(e) if e == "eof" => return Ok(()),
            Err(e) => return Err(e),
        };
        let rpc = match serde_json::from_slice::<RpcRequest>(&body) {
            Ok(r) => r,
            Err(e) => {
                let reply = json!({ "ok": false, "error": format!("invalid json: {e}") });
                let mut w = writer.lock().map_err(|e| e.to_string())?;
                write_frame(&mut *w, &reply)?;
                continue;
            }
        };
        let id = rpc.id;
        if rpc.cmd == "llm_chat" {
            let st = Arc::clone(&state);
            let w = Arc::clone(&writer);
            let args = rpc.args;
            thread::spawn(move || {
                let reply = match st.dispatch("llm_chat", args) {
                    Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                    Err(error) => json!({ "id": id, "ok": false, "error": error }),
                };
                match w.lock() {
                    Ok(mut guard) => {
                        if let Err(e) = write_frame(&mut *guard, &reply) {
                            eprintln!("[dwh-host] llm reply write failed: {e}");
                        }
                    }
                    Err(e) => eprintln!("[dwh-host] llm reply lock poisoned: {e}"),
                }
            });
            continue;
        }
        let reply = match state.dispatch(&rpc.cmd, rpc.args) {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        };
        let mut w = writer.lock().map_err(|e| e.to_string())?;
        write_frame(&mut *w, &reply)?;
    }
}

fn read_frame<R: Read>(r: &mut R) -> Result<Vec<u8>, String> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Err("eof".into()),
        Err(e) => return Err(e.to_string()),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 64 * 1024 * 1024 {
        return Err(format!("frame too large: {len}"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(body)
}

fn write_frame<W: Write>(w: &mut W, value: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let len = (body.len() as u32).to_le_bytes();
    w.write_all(&len).map_err(|e| e.to_string())?;
    w.write_all(&body).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}
