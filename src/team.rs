//! A session's team: the sub-agents it can hand work to, and the ones it has run.
//!
//! Members are Claude Code's own agent files, `<project>/.claude/agents/<name>.md`,
//! so the session sees them as it sees any other. What the lead (the session itself)
//! is for is only a note for the page, kept in the tool's own records. The runs
//! are read from the session's `subagents/` folder, read-only.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::accounts::{self, Account};
use crate::history::{self, Entry, Tokens};
use crate::proc;
use crate::store::{self, state_file};
use crate::tools::{self, Tool};
use crate::util::{err, now_ms, path_str, squash, Result};

const MAX_NAME: usize = 48;
const MAX_JOB: usize = 400;
const MAX_INSTRUCTIONS: usize = 20_000;
const MAX_PROMPT: usize = 100_000;
/// What a member may run on: Claude Code's aliases, or a model's full id.
const MODELS: [&str; 4] = ["opus", "sonnet", "haiku", "inherit"];

pub fn teams_file() -> PathBuf {
    state_file("teams.json")
}

fn key(account_dir: &str, session_id: &str) -> String {
    format!("{account_dir}|{session_id}")
}

/// The account, the session's transcript (none before its first prompt) and the folder it runs in.
struct Place {
    account: Account,
    transcript: Option<PathBuf>,
    cwd: PathBuf,
}

/// `running_in` is the folder Claude Code reports for a running session, for one
/// whose transcript does not say yet: it holds nothing but a title until the first prompt.
fn find(account: &str, session_id: &str, running_in: Option<&str>) -> Result<(Place, Entry)> {
    let account = accounts::get_account(account)?;
    if account.tool != Tool::Claude {
        return err("Teams are made of Claude Code sub-agents, so only Claude Code sessions have one.");
    }
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return err("That is not a session id.");
    }
    let file = format!("{session_id}.jsonl");
    let transcript = fs::read_dir(Path::new(&account.dir).join("projects"))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|folder| folder.path().join(&file))
        .find(|path| path.is_file());
    let entry = transcript.as_deref().map(indexed).unwrap_or_default();
    let cwd = entry.cwd.clone().or_else(|| running_in.filter(|c| !c.is_empty()).map(String::from));
    let Some(cwd) = cwd else {
        return err("This session does not say which folder it runs in yet. Send it a prompt first.");
    };
    Ok((Place { account, transcript, cwd: PathBuf::from(cwd) }, entry))
}

fn agents_dir(cwd: &Path) -> PathBuf {
    cwd.join(".claude").join("agents")
}

/// The model that wrote most, as the one a conversation runs on.
fn main_model(models: &BTreeMap<String, Tokens>) -> Option<String> {
    models.iter().max_by_key(|(_, t)| t.output).map(|(m, _)| m.clone())
}

// ------------------------------------------------------------------ reading

/// The team of a session: who leads it, its members and what they have run.
/// `running_in` is set while the session is open, so a run it never finished can
/// be told from one still going.
pub fn team(account: &str, session_id: &str, running_in: Option<&str>, title: Option<String>) -> Result<Value> {
    let open = running_in.is_some();
    let (place, entry) = find(account, session_id, running_in)?;
    let job = load_leads()?.get(&key(&place.account.dir, session_id)).and_then(Value::as_str).map(String::from);
    let members = members(&place.cwd);
    let runs = runs(&place, open);
    Ok(json!({
        "account": place.account.name,
        "sessionId": session_id,
        "title": title.or(entry.title).unwrap_or_else(|| session_id.to_string()),
        "cwd": path_str(&place.cwd),
        "open": open,
        "agentsDir": path_str(&agents_dir(&place.cwd)),
        "lead": { "model": main_model(&entry.models), "job": job, "tokens": entry.tokens },
        "members": members,
        "runs": runs,
    }))
}

fn members(cwd: &Path) -> Vec<Value> {
    let Ok(files) = fs::read_dir(agents_dir(cwd)) else { return Vec::new() };
    let mut found: Vec<Value> = files
        .flatten()
        .map(|f| f.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md") && p.is_file())
        .filter_map(|path| {
            let text = fs::read_to_string(&path).ok()?;
            let (fields, body) = split(&text);
            let field = |name: &str| fields.iter().find(|(k, _)| k == name).map(|(_, v)| value_of(v));
            let file = path.file_stem()?.to_string_lossy().into_owned();
            Some(json!({
                "file": file,
                "name": field("name").filter(|n| !n.is_empty()).unwrap_or_else(|| file.clone()),
                "job": field("description").unwrap_or_default(),
                "model": field("model").filter(|m| !m.is_empty()).unwrap_or_else(|| "inherit".into()),
                "tools": field("tools"),
                "instructions": body.trim(),
            }))
        })
        .collect();
    found.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    found
}

fn mtime_ms(meta: &fs::Metadata) -> Option<u128> {
    Some(meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis())
}

/// A transcript, indexed. Each is read again only when it has changed, as the
/// pages ask every few seconds.
fn indexed(path: &Path) -> Entry {
    static SEEN: Mutex<BTreeMap<PathBuf, (u64, u128, Entry)>> = Mutex::new(BTreeMap::new());
    let stamp = fs::metadata(path).ok().and_then(|m| Some((m.len(), mtime_ms(&m)?)));
    let mut seen = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let (Some((size, at, entry)), Some(stamp)) = (seen.get(path), stamp) {
        if (*size, *at) == stamp {
            return entry.clone();
        }
    }
    let entry = history::index_transcript(path);
    if let Some((size, at)) = stamp {
        seen.insert(path.to_path_buf(), (size, at, entry.clone()));
    }
    entry
}

/// What each sub-agent the session started did, oldest first.
fn runs(place: &Place, open: bool) -> Vec<Value> {
    let Some(transcript) = &place.transcript else { return Vec::new() };
    let dir = transcript.with_extension("").join("subagents");
    let mut files = Vec::new();
    agent_files(&dir, &mut files);
    let mut found: Vec<(i64, Value)> = files
        .into_iter()
        .filter_map(|path| {
            let mtime = mtime_ms(&fs::metadata(&path).ok()?)?;
            let entry = indexed(&path);
            let about = store::read_json_or_null(&path.with_extension("meta.json"));
            let text = |name: &str| about.get(name).and_then(Value::as_str).unwrap_or("").to_string();
            let finished = about.get("finished").and_then(Value::as_bool).unwrap_or(false);
            let started = entry.started_at.unwrap_or(mtime as i64);
            let id = path.file_stem()?.to_string_lossy().trim_start_matches("agent-").to_string();
            Some((started, json!({
                "id": id,
                "type": Some(text("agentType")).filter(|t| !t.is_empty()).unwrap_or_else(|| "general-purpose".into()),
                "task": text("description"),
                "model": main_model(&entry.models),
                "depth": about.get("spawnDepth").and_then(Value::as_u64).unwrap_or(1),
                "state": if finished { "done" } else if open { "running" } else { "stopped" },
                "tokens": entry.tokens,
                "startedAt": started,
                "lastAt": mtime as i64,
            })))
        })
        .collect();
    found.sort_by_key(|(at, _)| *at);
    found.into_iter().map(|(_, run)| run).collect()
}

/// The Claude Code sessions whose sub-agents have worked since `since` (ms since
/// 1970), as (account name, session id), the most recently busy first.
pub fn recent(since: i64) -> Result<Vec<(String, String)>> {
    let mut found: Vec<(u128, String, String)> = Vec::new();
    for acc in accounts::load_accounts(false)?.into_iter().filter(|a| a.tool == Tool::Claude) {
        let Ok(projects) = fs::read_dir(Path::new(&acc.dir).join("projects")) else { continue };
        for session in projects.flatten().filter_map(|p| fs::read_dir(p.path()).ok()).flatten().flatten() {
            let mut files = Vec::new();
            agent_files(&session.path().join("subagents"), &mut files);
            let last = files.iter().filter_map(|f| mtime_ms(&fs::metadata(f).ok()?)).max();
            if let Some(last) = last.filter(|at| *at as i64 >= since) {
                found.push((last, acc.name.clone(), session.file_name().to_string_lossy().into_owned()));
            }
        }
    }
    found.sort_by_key(|(at, ..)| std::cmp::Reverse(*at));
    Ok(found.into_iter().map(|(_, account, session)| (account, session)).collect())
}

/// `agent-*.jsonl` under a session's `subagents/`, a workflow's a folder further down.
fn agent_files(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(files) = fs::read_dir(dir) else { return };
    for file in files.flatten() {
        let path = file.path();
        let name = file.file_name().to_string_lossy().into_owned();
        match file.file_type() {
            Ok(t) if t.is_dir() => agent_files(&path, found),
            Ok(t) if t.is_file() && name.starts_with("agent-") && name.ends_with(".jsonl") => found.push(path),
            _ => {}
        }
    }
}

// ----------------------------------------------------------- agent files

/// Front matter as `(key, lines)` in order, a key's lines being its own and any
/// that continue it, and the text after it. A file without any is all text.
fn split(text: &str) -> (Vec<(String, Vec<String>)>, String) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return (Vec::new(), text.to_string());
    };
    let mut fields: Vec<(String, Vec<String>)> = Vec::new();
    let mut read = 0;
    for line in rest.split_inclusive('\n') {
        read += line.len();
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare == "---" {
            return (fields, rest[read..].to_string());
        }
        match fields.last_mut() {
            Some((_, kept)) if bare.is_empty() || bare.starts_with([' ', '\t']) => kept.push(bare.to_string()),
            _ => fields.push((bare.split(':').next().unwrap_or("").trim().to_string(), vec![bare.to_string()])),
        }
    }
    // Never closed: not front matter after all.
    (Vec::new(), text.to_string())
}

/// A member's file name, as the page sends it back: one name, no folders.
fn plain_file(file: &str) -> bool {
    !file.is_empty() && !file.contains(['/', '\\']) && !file.starts_with('.')
}

/// A field's value: on its line, quoted or not, or folded from the lines under it.
fn value_of(lines: &[String]) -> String {
    let first = lines.first().map(String::as_str).unwrap_or("");
    let value = first.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
    if matches!(value, "|" | ">" | "|-" | ">-" | "") && lines.len() > 1 {
        return squash(&lines[1..].join(" "));
    }
    if value.starts_with('"') {
        if let Ok(Value::String(s)) = serde_json::from_str::<Value>(value) {
            return s;
        }
    }
    if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        return inner.replace("''", "'");
    }
    value.to_string()
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= MAX_NAME
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_model(model: &str) -> bool {
    MODELS.contains(&model)
        || (model.starts_with("claude-") && model.len() <= 64 && model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '[' | ']')))
}

/// The file's text with `name`, `description` and `model` set, keeping whatever
/// else its front matter says (tools, colour, ...) as it was.
fn render(old: Option<&str>, name: &str, job: &str, model: &str, instructions: &str) -> String {
    let (mut fields, _) = old.map(split).unwrap_or_default();
    let quoted = serde_json::to_string(job).unwrap_or_default();
    for (field, line) in [("name", format!("name: {name}")), ("description", format!("description: {quoted}")), ("model", format!("model: {model}"))] {
        match fields.iter_mut().find(|(k, _)| k == field) {
            Some((_, lines)) => *lines = vec![line],
            None => fields.push((field.to_string(), vec![line])),
        }
    }
    let head: Vec<String> = fields.into_iter().flat_map(|(_, lines)| lines).collect();
    format!("---\n{}\n---\n\n{}\n", head.join("\n"), instructions.trim())
}

/// Written when no instructions are given, so the member knows its place.
fn default_instructions(name: &str, job: &str) -> String {
    format!(
        "You are {name}, one member of a team. The lead (the main session) hands you work.\n\n\
         What you do: {job}\n\n\
         Do only that, then report back to the lead: what you found, and anything you could not do."
    )
}

/// Add a member, or change one (`file` is the one being changed; a new name renames it).
pub fn save_member(account: &str, session_id: &str, running_in: Option<&str>, member: &Value) -> Result<Value> {
    let (place, _) = find(account, session_id, running_in)?;
    let text = |field: &str| member.get(field).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let (name, model, file) = (text("name"), text("model"), text("file"));
    let job = squash(&text("job"));
    let instructions = text("instructions");
    if !valid_name(&name) {
        return err("A name is lowercase letters, digits and dashes, starting with a letter, like 'scorer'.");
    }
    if job.is_empty() || job.chars().count() > MAX_JOB {
        return err(format!("Say in a sentence what {name} does (up to {MAX_JOB} characters). The lead reads it to decide when to hand work over."));
    }
    let model = if model.is_empty() { "inherit".to_string() } else { model };
    if !valid_model(&model) {
        return err("The model is opus, sonnet, haiku, inherit, or a model's full id.");
    }
    if instructions.len() > MAX_INSTRUCTIONS {
        return err("The instructions are too long.");
    }
    if !file.is_empty() && !plain_file(&file) {
        return err("That member could not be found.");
    }
    let dir = agents_dir(&place.cwd);
    let path = dir.join(format!("{name}.md"));
    let previous = (!file.is_empty()).then(|| dir.join(format!("{file}.md")));
    if previous.as_ref() != Some(&path) && path.exists() {
        return err(format!("There is already a member called {name}."));
    }
    let old = previous.as_ref().and_then(|p| fs::read_to_string(p).ok());
    let instructions = if instructions.is_empty() { default_instructions(&name, &job) } else { instructions };
    store::write_text(&path, &render(old.as_deref(), &name, &job, &model, &instructions), false)?;
    if let Some(previous) = previous.filter(|p| *p != path && p.exists()) {
        fs::remove_file(previous)?;
    }
    Ok(json!({ "ok": true, "path": path_str(&path) }))
}

/// Take a member off the team. Its file is moved into the tool's own records, not deleted.
pub fn remove_member(account: &str, session_id: &str, running_in: Option<&str>, file: &str) -> Result<Value> {
    let (place, _) = find(account, session_id, running_in)?;
    if !plain_file(file) {
        return err("That member could not be found.");
    }
    let path = agents_dir(&place.cwd).join(format!("{file}.md"));
    if !path.is_file() {
        return err("That member could not be found. It may have been removed already.");
    }
    let kept = state_file("removed-agents").join(format!("{}-{file}.md", now_ms()));
    fs::create_dir_all(kept.parent().unwrap_or(Path::new(".")))?;
    if fs::rename(&path, &kept).is_err() {
        fs::copy(&path, &kept)?;
        fs::remove_file(&path)?;
    }
    Ok(json!({ "ok": true, "keptAt": path_str(&kept) }))
}

// ---------------------------------------------------------------- running

/// Set the team to work: Claude Code runs the session in the background (`claude --bg`),
/// so the team page can follow it. A closed session is continued; one open in a terminal
/// is left alone, and the team starts as a new session beside it, in the same folder.
/// Returns the background session's short id, as `claude agents` lists it.
pub fn run(account: &str, session_id: &str, running_in: Option<&str>, prompt: &str, model: &str) -> Result<String> {
    let (place, _) = find(account, session_id, running_in)?;
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > MAX_PROMPT {
        return err("Say what the team should work on.");
    }
    if model == "inherit" || !valid_model(model) {
        return err("The lead runs on opus, sonnet, haiku, or a model's full id.");
    }
    let mut cmd = tools::command(&place.account)?;
    cmd.current_dir(&place.cwd).args(["--bg", "--model", model]);
    if running_in.is_none() && place.transcript.is_some() {
        cmd.args(["--resume", session_id]);
    }
    cmd.args(["--", prompt]);
    let output = proc::run(&mut cmd, Duration::from_secs(60))?;
    match backgrounded(&output.stdout) {
        Some(id) => Ok(id),
        None => err(format!("Claude Code did not start it: {}", output.last_line())),
    }
}

/// The id in `claude --bg`'s "backgrounded · <id>".
fn backgrounded(stdout: &str) -> Option<String> {
    let line = stdout.lines().find(|l| l.trim_start().starts_with("backgrounded"))?;
    let id = line.rsplit([' ', '\u{b7}']).find(|w| !w.is_empty())?;
    id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-').then(|| id.to_string())
}

// --------------------------------------------------------------- the lead

fn load_leads() -> Result<Map<String, Value>> {
    Ok(store::read_json(&teams_file())?.and_then(|data| data.get("leads").and_then(Value::as_object).cloned()).unwrap_or_default())
}

/// What the lead is for, as the page shows it. Empty forgets it.
pub fn set_lead(account: &str, session_id: &str, running_in: Option<&str>, job: &str) -> Result<Value> {
    let (place, _) = find(account, session_id, running_in)?;
    let job: String = squash(job).chars().take(MAX_JOB).collect();
    store::locked(|| {
        let mut leads = load_leads()?;
        match job.is_empty() {
            true => leads.remove(&key(&place.account.dir, session_id)),
            false => leads.insert(key(&place.account.dir, session_id), json!(job)),
        };
        store::write_json(&teams_file(), &json!({ "version": 1, "leads": leads }), true)
    })?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_front_matter() {
        let text = "---\nname: scorer\ndescription: \"Scores: the report\"\nmodel: sonnet\ntools: Read, Grep\ncolor: blue\n---\n\nYou score.\n";
        let (fields, body) = split(text);
        assert_eq!(fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["name", "description", "model", "tools", "color"]);
        assert_eq!(value_of(&fields[1].1), "Scores: the report");
        assert_eq!(body.trim(), "You score.");
        let folded = "---\nname: x\ndescription: >\n  one\n  two\n---\nbody";
        let (fields, body) = split(folded);
        assert_eq!(value_of(&fields[1].1), "one two");
        assert_eq!(body, "body");
        assert!(split("no front matter").0.is_empty());
        assert!(split("---\nname: never closed\n").0.is_empty());
    }

    #[test]
    fn keeps_what_it_does_not_change() {
        let old = "---\nname: scorer\ndescription: >\n  old\n  job\ntools: Read\ncolor: blue\n---\nold body\n";
        let new = render(Some(old), "grader", "Scores \"it\"", "haiku", "New body");
        assert_eq!(new, "---\nname: grader\ndescription: \"Scores \\\"it\\\"\"\ntools: Read\ncolor: blue\nmodel: haiku\n---\n\nNew body\n");
        let (fields, body) = split(&new);
        assert_eq!(value_of(&fields[1].1), "Scores \"it\"");
        assert_eq!(body.trim(), "New body");
    }

    #[test]
    fn reads_the_background_id() {
        assert_eq!(backgrounded("backgrounded \u{b7} eeda6102\n  claude agents   list sessions\n").as_deref(), Some("eeda6102"));
        assert_eq!(backgrounded("Workspace not trusted. Run `claude` in /x once"), None);
    }

    #[test]
    fn names_and_models() {
        assert!(valid_name("answer-checker"));
        assert!(!valid_name("Answer"));
        assert!(!valid_name("../x"));
        assert!(!valid_name("-x"));
        assert!(valid_model("haiku"));
        assert!(valid_model("claude-sonnet-5-5"));
        assert!(!valid_model("gpt-5"));
        assert!(!valid_model("sonnet\nmalicious: true"));
    }
}
