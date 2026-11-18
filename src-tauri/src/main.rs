#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use jobbsoknader_lib::varsel;

fn main() {
    if std::env::args().any(|a| a == varsel::ARGUMENT) {
        match varsel::kjør_i_bakgrunnen() {
            Ok(_) => std::process::exit(0),
            Err(e) => {
                eprintln!("fristvarselet feilet: {e}");
                std::process::exit(1);
            }
        }
    }
    jobbsoknader_lib::radar_bakgrunn::forbered();
    jobbsoknader_lib::run()
}
