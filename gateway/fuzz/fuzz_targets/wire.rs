#![no_main]
use libfuzzer_sys::fuzz_target;
use mailgw_core::wire::{self, Event, Frame};
fuzz_target!(|bytes: &[u8]| {
    drop(mailgw_core::inspect_structure(bytes));
    for imap in [false, true] {
        let mut fr = Frame::default();
        for mut chunk in bytes.chunks(17) {
            while !chunk.is_empty() {
                match fr.consume(&mut chunk, imap, true) {
                    Ok(Event::Complete(cmd)) if imap => { drop(wire::imap(&cmd)); }
                    Ok(Event::Complete(cmd)) => { drop(wire::smtp(&cmd)); }
                    Ok(_) => (), Err(_) => return,
                }
            }
        }
    }
});
