/**
 * The capture script that runs INSIDE the export sandbox (python3 + Playwright
 * + ffmpeg). It is a string here so the Vercel bundle carries it without file
 * tracing; the job writes it to /opt/cr-export/render.py and runs it with the
 * job JSON path (lib/server/export-mp4/plan.ts guestJob).
 *
 * Timing is a virtual clock, so the output is exactly fps frames per page
 * second however slow screenshots are: Playwright's page.clock owns Date,
 * timers and requestAnimationFrame, and every running Web Animation (CSS
 * animations and transitions) is paused and stepped by the same dt per frame.
 * Frames go as JPEG into one ffmpeg process (image2pipe -> libx264 yuv420p,
 * constant 30 fps, +faststart). Order: ad card, replay, hold on result, ad card.
 *
 * Stdout protocol: "CR_PROGRESS <frames>" while capturing, and one final
 * "CR_RESULT <json>" line. Exit 3 means the replay never signalled done.
 */
export const RENDER_PY = String.raw`
import json, subprocess, sys, time

from playwright.sync_api import sync_playwright

STEP_JS = """
(dt) => {
  const mine = (window.__crAnims = window.__crAnims || new WeakSet());
  for (const a of document.getAnimations()) {
    if (a.playState === 'running') { a.pause(); mine.add(a); }
    if (mine.has(a) && a.playState === 'paused') { a.currentTime = (a.currentTime || 0) + dt; }
  }
  return window.__CR_REPLAY_DONE === true;
}
"""


def main():
    job = json.load(open(sys.argv[1]))
    fps, w, h = job["fps"], job["width"], job["height"]
    t0 = time.time()
    ff = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
         "-vf", "scale=in_range=full:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-color_range", "tv",
         "-r", str(fps), "-movflags", "+faststart", job["out"]],
        stdin=subprocess.PIPE,
    )
    written = 0

    def put(img, n=1):
        nonlocal written
        for _ in range(n):
            ff.stdin.write(img)
            written += 1

    done_at = None
    replay_frames = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"])
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="dark")
        card_page = ctx.new_page()
        card_page.set_content(job["ad_html"], wait_until="load")
        card = card_page.screenshot(type="jpeg", quality=92)
        card_page.close()
        put(card, job["ad_frames"])

        page = ctx.new_page()
        page.clock.install()
        page.goto(job["url"], wait_until="load", timeout=45000)
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        elapsed_ms = 0
        while replay_frames < job["max_replay_frames"] + job["hold_frames"]:
            target = round((replay_frames + 1) * 1000 / fps)
            step = target - elapsed_ms
            elapsed_ms = target
            page.clock.run_for(step)
            is_done = page.evaluate(STEP_JS, step)
            put(page.screenshot(type="jpeg", quality=88))
            replay_frames += 1
            if done_at is None and is_done:
                done_at = replay_frames
            if done_at is not None and replay_frames - done_at >= job["hold_frames"]:
                break
            if done_at is None and replay_frames >= job["max_replay_frames"]:
                break
            if replay_frames % 15 == 0:
                print("CR_PROGRESS %d" % replay_frames, flush=True)
        put(card, job["ad_frames"])
        browser.close()

    ff.stdin.close()
    rc = ff.wait()
    result = {"frames": written, "replay_frames": replay_frames, "done": done_at is not None,
              "capture_ms": int((time.time() - t0) * 1000), "ffmpeg_rc": rc}
    print("CR_RESULT " + json.dumps(result), flush=True)
    if rc != 0:
        sys.exit(2)
    if job["require_done"] and done_at is None:
        sys.exit(3)


if __name__ == "__main__":
    main()
`;
