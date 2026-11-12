//! Product side: one long-lived Bun process (`host.ts`) over the disposable PostgreSQL in
//! TEAR_DATABASE_URL. `open` resets it to a fresh synthetic workspace; `act` runs one action and
//! returns the observation (request result, statements it unblocked, committed view, safety).
use serde_json::{Value, json};
use statecheck::{Error, R};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct Host {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

fn error(e: impl std::fmt::Display) -> Error {
    Error::new(e.to_string())
}

impl Host {
    pub fn spawn() -> R<Self> {
        let api = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let log = std::env::var("TEAR_LOG")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/target/host.log").into());
        let log = std::fs::File::create(log).map_err(error)?;
        let mut child = Command::new(std::env::var("BUN").unwrap_or_else(|_| "bun".into()))
            .arg("tear/inbox/host.ts")
            .current_dir(api)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()
            .map_err(error)?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Ok(Host {
            child,
            stdin,
            stdout,
        })
    }

    fn call(&mut self, request: Value) -> R<Value> {
        writeln!(self.stdin, "{request}")
            .and_then(|_| self.stdin.flush())
            .map_err(error)?;
        let mut line = String::new();
        if self.stdout.read_line(&mut line).map_err(error)? == 0 {
            // A refused database (see ../disposable.ts) or a crash: surface the host's last words.
            let log = std::env::var("TEAR_LOG").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/target/host.log").into());
            let text = std::fs::read_to_string(&log).unwrap_or_default();
            let tail: Vec<&str> = text.lines().rev().take(3).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            return Err(Error::new(format!("host exited ({log}): {}", tail.join(" | "))));
        }
        let reply: Value = serde_json::from_str(&line).map_err(error)?;
        if reply["ok"] == json!(true) {
            Ok(reply.get("value").cloned().unwrap_or(Value::Null))
        } else {
            Err(Error::new(format!(
                "host: {}",
                reply["error"].as_str().unwrap_or("failed")
            )))
        }
    }

    pub fn reset(&mut self, quota: Option<i64>) -> R<()> {
        self.call(json!({"op": "reset", "quota": quota}))
            .map(|_| ())
    }

    pub fn act(&mut self, action: &str) -> R<Value> {
        self.call(json!({"op": "act", "action": action}))
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "{}", json!({"op": "quit"}));
        let _ = self.stdin.flush();
        let _ = self.child.wait();
    }
}
