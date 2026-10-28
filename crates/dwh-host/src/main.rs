//! Localhost JSON-RPC host for Electron.
//!
//! Prints `DWH_HOST_READY <port>` on stdout when listening on 127.0.0.1.
//! POST /rpc  body: {"cmd":"preview_workspace","args":{...}}
//! Response: {"ok":true,"result":...} | {"ok":false,"error":"..."}

use dwh_host::{configure_paths, HostState};
use serde::Deserialize;
use serde_json::json;
use std::io::Cursor;
use std::sync::Arc;
use tiny_http::{Header, Method, Response, Server, StatusCode};

#[derive(Deserialize)]
struct RpcRequest {
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

    let server = Server::http("127.0.0.1:0").unwrap_or_else(|e| {
        eprintln!("[dwh-host] bind failed: {e}");
        std::process::exit(1);
    });
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    // Electron reads this line.
    println!("DWH_HOST_READY {port}");
    let _ = std::io::Write::flush(&mut std::io::stdout());

    eprintln!("[dwh-host] listening on http://127.0.0.1:{port}");

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();

        if method == Method::Get && (url == "/health" || url.starts_with("/health?")) {
            let _ = request.respond(Response::from_string("ok"));
            continue;
        }

        if method != Method::Post || !url.starts_with("/rpc") {
            let _ = request.respond(
                Response::from_string("not found").with_status_code(StatusCode(404)),
            );
            continue;
        }

        let mut body = Vec::new();
        if let Err(e) = std::io::Read::read_to_end(request.as_reader(), &mut body) {
            let _ = request.respond(
                Response::from_string(format!("read error: {e}")).with_status_code(StatusCode(400)),
            );
            continue;
        }

        let reply = match serde_json::from_slice::<RpcRequest>(&body) {
            Ok(rpc) => match state.dispatch(&rpc.cmd, rpc.args) {
                Ok(result) => json!({ "ok": true, "result": result }),
                Err(error) => json!({ "ok": false, "error": error }),
            },
            Err(e) => json!({ "ok": false, "error": format!("invalid json: {e}") }),
        };

        let bytes = serde_json::to_vec(&reply).unwrap_or_else(|_| b"{}".to_vec());
        let mut response = Response::new(
            StatusCode(200),
            vec![Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()],
            Cursor::new(bytes.clone()),
            Some(bytes.len()),
            None,
        );
        // CORS for safety if ever hit from browser tooling
        if let Ok(h) = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]) {
            response.add_header(h);
        }
        let _ = request.respond(response);
    }
}
