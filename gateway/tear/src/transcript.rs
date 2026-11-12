//! Replay a client transcript as a tear trace, and shrink it if it fails.
//!
//! A transcript is a reported client session (synthetic or redacted: never real mail),
//! one line per command, prefixed by the session that sent it; `S:` lines are server-side
//! events. Connection setup (LOGIN, CAPABILITY, ID, ENABLE, LOGOUT) is implicit and skipped.
//!
//! ```text
//! # NeoMutt marks read silently while a phone flags the same message
//! S: deliver
//! A: a1 NOOP
//! B: b1 NOOP
//! B: b2 STORE 1 +FLAGS (\Flagged)
//! A: a2 STORE 1 +FLAGS.SILENT (\Seen)
//! A: a3 NOOP
//! ```
//!
//! A JSON array of action labels is accepted too. Commands outside the model's alphabet are
//! reported with their line number instead of being guessed at.
use crate::model::{Config, FLAG_NAMES, FOLDERS, parse};
use serde_json::{Value, json};
use statecheck::{Error, R};

fn flag(name: &str) -> Option<&'static str> {
    FLAG_NAMES
        .iter()
        .find(|(_, f)| f.eq_ignore_ascii_case(name))
        .map(|(k, _)| *k)
}
fn folder(name: &str) -> Option<&'static str> {
    let name = name.trim_matches('"');
    FOLDERS
        .iter()
        .find(|f| f.eq_ignore_ascii_case(name))
        .copied()
}

/// Translate one client command (without tag) of session `s` into a model action label.
fn command(s: &str, words: &[&str]) -> Result<Option<String>, String> {
    let upper: Vec<String> = words.iter().map(|w| w.to_ascii_uppercase()).collect();
    let u: Vec<&str> = upper.iter().map(String::as_str).collect();
    let (uid, rest) = if u.first() == Some(&"UID") {
        (true, &u[1..])
    } else {
        (false, &u[..])
    };
    let raw = if uid { &words[1..] } else { words };
    let label = match rest {
        ["LOGIN", ..]
        | ["AUTHENTICATE", ..]
        | ["CAPABILITY"]
        | ["ID", ..]
        | ["ENABLE", ..]
        | ["LOGOUT"]
        | ["NAMESPACE"]
        | ["LIST", ..]
        | ["LSUB", ..]
        | ["STATUS", ..] => return Ok(None),
        ["SELECT", f] | ["EXAMINE", f] => {
            let f = folder(raw[1]).ok_or_else(|| format!("folder {f} is not modelled"))?;
            format!("{s} {} {f}", rest[0].to_ascii_lowercase())
        }
        ["NOOP"] | ["CHECK"] => format!("{s} noop"),
        ["IDLE"] => format!("{s} idle"),
        ["DONE"] => format!("{s} done"),
        ["EXPUNGE"] if !uid => format!("{s} expunge"),
        ["EXPUNGE", "1:*"] if uid => format!("{s} uid-expunge"),
        ["CLOSE"] => format!("{s} close"),
        ["UNSELECT"] => format!("{s} unselect"),
        ["STORE", set, item, ..] => {
            let silent = item.ends_with(".SILENT");
            let op = item
                .chars()
                .next()
                .filter(|c| *c == '+' || *c == '-')
                .ok_or("STORE FLAGS (replace) is not modelled")?;
            let names: Vec<&str> = raw[3..]
                .iter()
                .map(|w| w.trim_matches(|c| c == '(' || c == ')'))
                .collect();
            let [name] = names.as_slice() else {
                return Err("STORE of one flag at a time only".into());
            };
            let f = flag(name).ok_or_else(|| format!("flag {name} is not modelled"))?;
            let set = match (*set, uid) {
                ("1", false) | (_, true) => "1",
                ("1:*", false) => "1:*",
                _ => return Err(format!("sequence set {set} is not modelled (use 1 or 1:*)")),
            };
            format!(
                "{s} {}store {op}{f} {} {set}",
                if uid { "uid-" } else { "" },
                if silent { "silent" } else { "loud" }
            )
        }
        ["FETCH", set, ..]
            if raw
                .iter()
                .any(|w| w.to_ascii_uppercase().contains("BODY[]")) =>
        {
            if !uid && *set != "1" {
                return Err(format!("FETCH {set} BODY[] is not modelled (use 1)"));
            }
            format!("{s} {}fetch-body 1", if uid { "uid-" } else { "" })
        }
        ["FETCH", ..] => return Ok(None),
        ["COPY", _, f] | ["MOVE", _, f] => {
            let f = folder(raw[2]).ok_or_else(|| format!("folder {f} is not modelled"))?;
            format!(
                "{s} {}{} 1 {f}",
                if uid { "uid-" } else { "" },
                rest[0].to_ascii_lowercase()
            )
        }
        ["APPEND", f, ..] => {
            let f = folder(raw[1]).ok_or_else(|| format!("folder {f} is not modelled"))?;
            format!("{s} append {f}")
        }
        ["CREATE", f] | ["DELETE", f] if folder(raw[1]) == Some("Work") => {
            let _ = f;
            format!("{s} {} Work", rest[0].to_ascii_lowercase())
        }
        _ => return Err(format!("command {} is not modelled", words.join(" "))),
    };
    if parse(&label).is_none() {
        return Err(format!("translated to an unknown action {label}"));
    }
    Ok(Some(label))
}

/// Translate a transcript into action labels.
pub fn translate(text: &str) -> Result<Vec<String>, String> {
    if text.trim_start().starts_with('[') {
        let v: Vec<String> = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if let Some(bad) = v.iter().find(|a| parse(a).is_none()) {
            return Err(format!("unknown action {bad}"));
        }
        return Ok(v);
    }
    let mut out = vec![];
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (who, rest) = line
            .split_once(':')
            .ok_or_else(|| format!("line {}: expected 'A: tag COMMAND'", n + 1))?;
        let who = who.trim();
        let words: Vec<&str> = rest.split_whitespace().collect();
        if who == "S" {
            let label = words.join(" ");
            if parse(&label).is_none() {
                return Err(format!("line {}: unknown server event {label}", n + 1));
            }
            out.push(label);
            continue;
        }
        if !crate::model::SESSIONS.contains(&who) {
            return Err(format!("line {}: unknown session {who}", n + 1));
        }
        // "DONE" has no tag; everything else does.
        let cmd = if words
            .first()
            .is_some_and(|w| w.eq_ignore_ascii_case("DONE"))
        {
            &words[..]
        } else {
            words.get(1..).unwrap_or_default()
        };
        match command(who, cmd) {
            Ok(Some(label)) => out.push(label),
            Ok(None) => {}
            Err(e) => return Err(format!("line {}: {e}", n + 1)),
        }
    }
    Ok(out)
}

pub fn run(cfg: Config, path: &str) -> R<Value> {
    let text = if path == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)
            .map_err(|e| Error::new(e.to_string()))?;
        s
    } else {
        std::fs::read_to_string(path).map_err(|e| Error::new(format!("{path}: {e}")))?
    };
    let actions = translate(&text).map_err(Error::new)?;
    let mut cfg = cfg;
    if actions.iter().any(|a| a.starts_with("C ")) {
        cfg.sessions = 3;
    }
    let mut out = crate::replay(cfg, &actions)?;
    out["actions"] = json!(actions);
    Ok(out)
}
