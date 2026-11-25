-- Read taps from the Kindle PW3 touch screen (cyttsp4_mt) and print "x y sec" per tap
-- (sec = kernel time of the touch-down, so the reader can drop taps made while it was busy).
-- With "key" as 2nd argument, read the power button device and print "POWER" per press.
-- input_event on 32-bit ARM: sec(4) usec(4) type(2) code(2) value(4) = 16 bytes.
local dev = arg[1] or "/dev/input/event1"
local mode = arg[2] or "touch"
local f = assert(io.open(dev, "rb"))
f:setvbuf("no")
local function u16(s, i) return s:byte(i) + s:byte(i + 1) * 256 end
local function i32(s, i)
  local v = s:byte(i) + s:byte(i + 1) * 256 + s:byte(i + 2) * 65536 + s:byte(i + 3) * 16777216
  if v >= 2147483648 then v = v - 4294967296 end
  return v
end
local active, x0, y0, x, y, t0 = false, nil, nil, nil, nil, 0
while true do
  local e = f:read(16)
  if not e or #e < 16 then break end
  local t, c, v = u16(e, 9), u16(e, 11), i32(e, 13)
  if mode == "key" then
    if t == 1 and c == 116 and v == 1 then  -- KEY_POWER pressed
      io.stdout:write("POWER\n")
      io.stdout:flush()
    end
  elseif t == 3 and c == 57 then            -- ABS_MT_TRACKING_ID
    if v == -1 then
      if active and x0 and y0 then
        local dx, dy = math.abs((x or x0) - x0), math.abs((y or y0) - y0)
        if dx < 80 and dy < 80 then      -- a tap, not a swipe
          io.stdout:write(x0, " ", y0, " ", t0, "\n")
          io.stdout:flush()
        end
      end
      active, x0, y0, x, y = false, nil, nil, nil, nil
    else
      active = true
      t0 = i32(e, 1)
    end
  elseif t == 3 and c == 53 then        -- ABS_MT_POSITION_X
    x = v; if not x0 then x0 = v end
  elseif t == 3 and c == 54 then        -- ABS_MT_POSITION_Y
    y = v; if not y0 then y0 = v end
  end
end
