// Fixture source for envgle integration tests. Never built, never run.
use std::env;

fn main() {
    // A read that panics when the variable is absent, and that no env file in
    // this project declares. It is the first read in the file on purpose, so
    // the finding does not depend on which read the scanner reports first.
    let api_token = env::var("API_TOKEN").unwrap();
    // A read with a default: the process starts with an empty value.
    let log_level = env::var("RUST_LOG").unwrap_or_default();
    // A read that is never given a default and never checked.
    let data_dir = env::var("DATA_DIR");

    let root = data_dir.unwrap_or_else(|_| String::from("."));
    println!("{log_level} {api_token} {root}");
}
