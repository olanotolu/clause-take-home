#!/usr/bin/env python3
"""Check the required encoding and duration of a completed walkthrough."""
import argparse, json, shutil, subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('video',type=Path);p.add_argument('--min-seconds',type=float,default=1);p.add_argument('--max-seconds',type=float,default=3600)
a=p.parse_args()
probe=shutil.which('ffprobe');encoder=shutil.which('ffmpeg')
if not probe or not encoder:p.error('ffmpeg and ffprobe must be installed')
if not a.video.is_file():p.error('Video does not exist')
meta=json.loads(subprocess.check_output([probe,'-v','error','-show_streams','-show_format','-of','json',str(a.video)],text=True))
v=next((s for s in meta['streams'] if s['codec_type']=='video'),None);audio=next((s for s in meta['streams'] if s['codec_type']=='audio'),None)
issues=[]
if v is None or v.get('codec_name')!='h264':issues.append('Expected H.264 video')
if audio is None or audio.get('codec_name')!='aac':issues.append('Expected AAC audio')
duration=float(meta['format']['duration'])
if not a.min_seconds<=duration<=a.max_seconds:issues.append('Duration is outside the requested range')
if v and (v['width'],v['height']) not in [(1920,1080),(1080,1920)]:issues.append('Expected a 1080p landscape or portrait frame')
if v and v.get('pix_fmt')!='yuv420p':issues.append('Expected playback-compatible yuv420p')
r=subprocess.run([encoder,'-v','error','-xerror','-i',str(a.video),'-f','null','-'],capture_output=True,text=True)
if r.returncode:issues.append('Decode failed: '+r.stderr[-1000:])
print(json.dumps({'file':str(a.video.resolve()),'duration':duration,'video':v and {k:v.get(k) for k in ['codec_name','width','height','r_frame_rate','pix_fmt']},'audio':audio and audio['codec_name'],'issues':issues},indent=2))
raise SystemExit(bool(issues))
