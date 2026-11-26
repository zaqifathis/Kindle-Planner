-- Read taps from the Kindle touch screen and print "x y sec" per tap (x, y in screen pixels)
-- (sec = kernel time of the touch-down, so the reader can drop taps made while it was busy).
-- With "key" as 2nd argument, read the power button device and print "POWER" per press.
-- input_event on 32-bit ARM: sec(4) usec(4) type(2) code(2) value(4) = 16 bytes.
-- Input device: a path, or "auto" = find it by what it can do (as KOReader does), so other Kindle models work too:
-- touch = the device reporting ABS_MT_POSITION_X (53), key = the one with KEY_POWER (116).
-- Tested on the Paperwhite 3 only: cyttsp4_mt = event1 (touch), max77696-onkey = event0 (power).
local function find_input(text, mode, wordbits)
  local typ, bit = "ABS", 53
  if mode == "key" then typ, bit = "KEY", 116 end
  local ev
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    if line == "" then ev = nil end
    ev = line:match("^H: Handlers=.-(event%d+)") or ev
    local t, mask = line:match("^B: (%u+)=(.*)$")
    if t == typ and ev then
      local words = {}
      for w in mask:gmatch("%x+") do table.insert(words, 1, w) end -- the lowest word is printed last
      local w = words[math.floor(bit / wordbits) + 1] or ""
      local b = bit % wordbits
      local i = #w - math.floor(b / 4)                -- one hex digit holds the bit: exact on 32- and 64-bit kernels
      local digit = i >= 1 and tonumber(w:sub(i, i), 16) or 0
      if math.floor(digit / 2 ^ (b % 4)) % 2 == 1 then return "/dev/input/" .. ev end
    end
  end
end

local dev = arg[1] or "/dev/input/event1"
local mode = arg[2] or "touch"
if dev == "--find" then                            -- test: lua touch.lua --find <devices file> <touch|key> <32|64>
  local f = assert(io.open(arg[2])); local text = f:read("*a"); f:close()
  print(find_input(text, arg[3], tonumber(arg[4])) or "none")
  return
end
if dev == "auto" then
  local f = io.open("/proc/bus/input/devices"); local text = f and f:read("*a") or ""; if f then f:close() end
  local p = io.popen("uname -m"); local arch = p and p:read("*l") or ""; if p then p:close() end
  dev = find_input(text, mode, arch:find("64") and 64 or 32)
    or (mode == "key" and "/dev/input/event0" or "/dev/input/event1") -- Paperwhite 3 paths
  io.stderr:write("input ", mode, ": ", dev, "\n")
end
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
