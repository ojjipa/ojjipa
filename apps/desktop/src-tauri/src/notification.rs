//! Short desktop previews; complete answers remain in Findings.
pub fn preview(message: &str) -> String {
    let mut parts = Vec::new();
    for line in message.lines() {
        if line.trim_start().starts_with('#') { continue; }
        let line = line.trim().trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c.is_whitespace());
        let line = line.split_once(". ")
            .filter(|(number, _)| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
            .map(|(_, content)| content).unwrap_or(line);
        if line.is_empty() { continue; }
        let words: Vec<_> = line.split_whitespace()
            .filter(|word| !word.contains("http://") && !word.contains("https://"))
            .map(|word| word.replace(['*', '`'], ""))
            .collect();
        let text = words.join(" ");
        if text.is_empty() { continue; }
        // Skip Markdown section labels, keeping the first actual takeaway.
        if text.ends_with(':') && words.len() <= 5 { continue; }
        for word in words {
            let ends_sentence = word.ends_with(['.', '!', '?']);
            parts.push(word);
            if ends_sentence { break; }
        }
        break;
    }
    let text = parts.join(" ");
    if text.is_empty() { return "A new result is ready.".into(); }
    let mut short = String::new();
    for (index, word) in text.split_whitespace().enumerate() {
        let extra = usize::from(!short.is_empty());
        if index >= 28 || short.chars().count() + extra + word.chars().count() > 200 {
            if short.is_empty() { short = word.chars().take(200).collect(); }
            short.push('…');
            break;
        }
        if !short.is_empty() { short.push(' '); }
        short.push_str(word);
    }
    short
}
