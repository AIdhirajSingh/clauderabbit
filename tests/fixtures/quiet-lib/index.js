function padStart(value, width, fill = " ") {
  const s = String(value);
  if (s.length >= width) return s;
  return fill.repeat(Math.ceil((width - s.length) / fill.length)).slice(0, width - s.length) + s;
}
module.exports = { padStart };
