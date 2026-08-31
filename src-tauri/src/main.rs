// Vinduet er hele appen; ingen konsoll skal følge med på Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jobbsoknader_lib::run()
}
