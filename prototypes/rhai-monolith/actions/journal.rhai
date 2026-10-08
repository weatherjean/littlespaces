fn add(input) {
    let text = clean(input.text);
    if text == "" { throw "Journal text is blank"; }
    let key = uuid();
    let entry = #{ text: text, createdAt: now_ms() };
    db_set(key, entry);
    #{ key: key, value: entry }
}
fn list(input) { newest_first(db_list()) }
