fn add(input) {
    let title = clean(input.title);
    if title == "" { throw "Task title is blank"; }
    let key = uuid();
    let task = #{ title: title, done: false };
    db_set(key, task);
    #{ key: key, value: task }
}
fn complete(input) {
    let task = db_get(input.key);
    if task == () { throw "Task not found"; }
    task.done = true;
    db_set(input.key, task);
    task
}
fn list(input) { db_list() }
