// Vinduet er hele appen; ingen konsoll skal følge med på Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use jobbsoknader_lib::varsel;

fn main() {
    /* launchd starter den samme binæren for å varsle om frister når
       appen er lukket. Da skal det ikke åpnes noe vindu. */
    if std::env::args().any(|a| a == varsel::ARGUMENT) {
        match varsel::kjør_i_bakgrunnen() {
            Ok(_) => std::process::exit(0),
            Err(e) => {
                eprintln!("fristvarselet feilet: {e}");
                std::process::exit(1);
            }
        }
    }
    jobbsoknader_lib::run()
}
