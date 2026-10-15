// Only enabled in the disposable worker; normal host allocation is unchanged.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
pub struct Budget;
pub static ENABLED: AtomicBool = AtomicBool::new(false);
static USED: AtomicUsize = AtomicUsize::new(0);
const LIMIT: usize = 128 * 1024 * 1024;
unsafe impl GlobalAlloc for Budget {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let used = USED.fetch_add(layout.size(), Ordering::Relaxed);
        if ENABLED.load(Ordering::Relaxed) && used.saturating_add(layout.size()) > LIMIT {
            USED.fetch_sub(layout.size(), Ordering::Relaxed);
            return std::ptr::null_mut();
        }
        let ptr = System.alloc(layout);
        if ptr.is_null() {
            USED.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        USED.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}
