//! NSSharingService integration: enumerate the system's Share destinations
//! (AirDrop, Mail, Messages, third-party share extensions) for a set of
//! files, and perform a chosen one.
//!
//! `sharingServicesForItems:` is deprecated (macOS 13) with no replacement
//! that can populate a custom menu; it still works and is the only way to
//! render Share inside our HTML context menu. If Apple ever breaks it, swap
//! the submenu for an NSSharingServicePicker anchored at the menu position.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]
#![allow(deprecated)]

use std::cell::RefCell;
use std::path::PathBuf;

use base64::Engine;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSSharingService;
use objc2_foundation::{NSArray, NSString, NSURL};
use serde::Serialize;

use super::icons::render_image_png;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDestination {
    pub title: String,
    /// PNG data: URL (32px, shown at 16px), or "" if rendering failed.
    pub icon: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareServices {
    pub generation: u64,
    pub services: Vec<ShareDestination>,
}

// A perform must invoke the same NSSharingService instance the user picked
// from the enumeration (extensions carry per-instance state), so the last
// batch is kept alive here, keyed by generation. Only ever touched from the
// main thread (callers marshal via on_main), hence thread_local.
thread_local! {
    static LAST_SERVICES: RefCell<(u64, Vec<Retained<NSSharingService>>)> =
        const { RefCell::new((0, Vec::new())) };
}

fn items_array(paths: &[PathBuf]) -> Retained<NSArray<AnyObject>> {
    let urls: Vec<Retained<NSURL>> = paths
        .iter()
        .map(|p| unsafe { NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy())) })
        .collect();
    let refs: Vec<&AnyObject> = urls.iter().map(|u| -> &AnyObject { u }).collect();
    NSArray::from_slice(&refs)
}

/// MUST run on the main thread.
pub fn share_services(paths: &[PathBuf]) -> ShareServices {
    let items = items_array(paths);
    let found = unsafe { NSSharingService::sharingServicesForItems(&items) };
    let mut kept = Vec::new();
    let mut services = Vec::new();
    for svc in found.iter() {
        let title = unsafe { svc.menuItemTitle() }.to_string();
        let image = unsafe { svc.image() };
        let icon = render_image_png(&image, 32)
            .map(|png| {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(png)
                )
            })
            .unwrap_or_default();
        services.push(ShareDestination { title, icon });
        kept.push(svc);
    }
    let generation = LAST_SERVICES.with(|c| {
        let mut c = c.borrow_mut();
        c.0 += 1;
        c.1 = kept;
        c.0
    });
    ShareServices { generation, services }
}

/// MUST run on the main thread. False if `generation` is no longer the
/// cached enumeration (menu gone stale) or `index` is out of range.
pub fn share_perform(generation: u64, index: usize, paths: &[PathBuf]) -> bool {
    let svc = LAST_SERVICES.with(|c| {
        let c = c.borrow();
        if c.0 != generation {
            return None;
        }
        c.1.get(index).cloned()
    });
    let Some(svc) = svc else {
        return false;
    };
    let items = items_array(paths);
    unsafe { svc.performWithItems(&items) };
    true
}
