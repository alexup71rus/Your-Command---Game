use std::collections::VecDeque;
use std::mem;
use std::slice;

const UNREACHABLE: u32 = u32::MAX;

#[no_mangle]
pub extern "C" fn allocate_u32(length: usize) -> *mut u32 {
    let mut values = Vec::<u32>::with_capacity(length);
    let pointer = values.as_mut_ptr();
    mem::forget(values);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn deallocate_u32(pointer: *mut u32, length: usize) {
    if length == 0 {
        return;
    }
    drop(Vec::from_raw_parts(pointer, 0, length));
}

#[no_mangle]
pub unsafe extern "C" fn multi_source_distances(
    passability_pointer: *const u32,
    source_pointer: *const u32,
    source_count: usize,
    rows: usize,
    columns: usize,
    output_pointer: *mut u32,
) {
    let cell_count = rows.saturating_mul(columns);
    if rows == 0 || columns == 0 || cell_count == 0 {
        return;
    }

    let passability = slice::from_raw_parts(passability_pointer, cell_count);
    let sources = slice::from_raw_parts(source_pointer, source_count);
    let output = slice::from_raw_parts_mut(output_pointer, cell_count);
    output.fill(UNREACHABLE);

    let mut queue = VecDeque::with_capacity(cell_count.min(1024));
    for &source in sources {
        let index = source as usize;
        if index >= cell_count || output[index] == 0 {
            continue;
        }
        output[index] = 0;
        queue.push_back(index);
    }

    while let Some(current) = queue.pop_front() {
        let row = current / columns;
        let column = current % columns;
        let next_distance = output[current].saturating_add(1);

        if column > 0 {
            visit(current - 1, next_distance, passability, output, &mut queue);
        }
        if column + 1 < columns {
            visit(current + 1, next_distance, passability, output, &mut queue);
        }
        if row > 0 {
            visit(current - columns, next_distance, passability, output, &mut queue);
        }
        if row + 1 < rows {
            visit(current + columns, next_distance, passability, output, &mut queue);
        }
    }
}

fn visit(
    index: usize,
    distance: u32,
    passability: &[u32],
    output: &mut [u32],
    queue: &mut VecDeque<usize>,
) {
    if passability[index] == 0 || distance >= output[index] {
        return;
    }
    output[index] = distance;
    queue.push_back(index);
}
