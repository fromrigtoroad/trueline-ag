import struct
import sys
sys.path.append('backend')
from ibt_parser import VAR_TYPE_INFO

with open('mock_telemetry.ibt', 'rb') as f:
    file_data = f.read()

# Parse main header
header_unpacked = struct.unpack('12i', file_data[:48])
print("Header ver:", header_unpacked[0])
print("Num vars:", header_unpacked[6])
print("Var header offset:", header_unpacked[7])
print("Buffer len:", header_unpacked[9])

var_bufs = []
for i in range(4):
    offset = 48 + i * 16
    tick_count, buf_offset, pad0, pad1 = struct.unpack('4i', file_data[offset:offset+16])
    var_bufs.append({'tickCount': tick_count, 'bufOffset': buf_offset})
print("Buffer offsets:", [v['bufOffset'] for v in var_bufs])

# Parse disk subheader
disk_subheader_data = file_data[112:112+32]
session_start_date, session_start_time, session_end_time, session_lap_count, session_record_count = struct.unpack('qddii', disk_subheader_data)
print("Session record count:", session_record_count)

# Parse variable headers
vars_dict = {}
for i in range(header_unpacked[6]):
    offset = header_unpacked[7] + i * 144
    var_data = file_data[offset:offset+144]
    v_type, v_offset, v_count, v_pad, v_name, v_desc, v_unit = struct.unpack('iiii32s64s32s', var_data)
    name_str = v_name.split(b'\x00')[0].decode('ascii')
    vars_dict[name_str] = {'type': v_type, 'offset': v_offset, 'count': v_count}
print("Variables found:", list(vars_dict.keys()))

def extract_val(record_bytes, var_meta):
    v_offset = var_meta['offset']
    v_type = var_meta['type']
    v_count = var_meta['count']
    type_size, fmt_char = VAR_TYPE_INFO[v_type]
    total_size = type_size * v_count
    chunk = record_bytes[v_offset:v_offset+total_size]
    if v_count == 1:
        return struct.unpack(fmt_char, chunk)[0]
    else:
        return list(struct.unpack(f"{v_count}{fmt_char}", chunk))

# Print first 5 records
data_offset = var_bufs[0]['bufOffset']
buf_len = header_unpacked[9]
for r in range(5):
    offset = data_offset + r * buf_len
    record_bytes = file_data[offset:offset+buf_len]
    print(f"Record {r}:")
    for name, meta in vars_dict.items():
        val = extract_val(record_bytes, meta)
        print(f"  {name}: {val}")
