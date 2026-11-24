import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMediaInfo } from '../src/main/video-export.mjs'

const base = {
  format: { duration: '2.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [
    {
      codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160,
      avg_frame_rate: '24000/1001', color_space: 'bt2020nc', color_transfer: 'smpte2084',
      color_primaries: 'bt2020', pix_fmt: 'yuv420p10le', side_data_list: [],
    },
    { codec_type: 'audio', codec_name: 'truehd', profile: 'Dolby TrueHD', channels: 8, channel_layout: '7.1', tags: { title: 'Atmos' } },
  ],
}

test('parses HDR10 video and Atmos audio metadata', () => {
  const info = parseMediaInfo(base, '/media/movie.mp4')
  assert.equal(info.container, 'mp4')
  assert.equal(info.duration, 2.5)
  assert.equal(info.video.hdr, true)
  assert.equal(info.video.hdrKind, 'HDR10')
  assert.equal(info.video.fps, 23.976)
  assert.equal(info.audio.label, 'Dolby TrueHD')
  assert.equal(info.audio.atmos, true)
})

test('recognizes Dolby Vision, HDR10+ and DTS-HD metadata', () => {
  const vision = structuredClone(base)
  vision.streams[0].side_data_list = [{ side_data_type: 'DOVI configuration record' }]
  assert.equal(parseMediaInfo(vision, '/media/movie.mkv').video.hdrKind, 'Dolby Vision')

  const plus = structuredClone(base)
  plus.streams[0].side_data_list = [{ side_data_type: 'HDR10+ Metadata' }]
  assert.equal(parseMediaInfo(plus, '/media/movie.mp4').video.hdrKind, 'HDR10+')

  const dts = structuredClone(base)
  dts.streams[1] = { codec_type: 'audio', codec_name: 'dts', profile: 'DTS-HD MA', channels: 6, channel_layout: '5.1' }
  const info = parseMediaInfo(dts, '/media/movie.mkv')
  assert.equal(info.audio.label, 'DTS · DTS-HD MA')
  assert.equal(info.audio.layout, '5.1')
  assert.equal(info.audio.atmos, false)
})

test('reports SDR when no HDR metadata is present', () => {
  const sdr = { format: { duration: '1', format_name: 'matroska,webm' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '25/1', color_space: 'unknown', color_transfer: 'unknown', color_primaries: 'unknown', pix_fmt: 'yuv420p' }] }
  const info = parseMediaInfo(sdr, '/media/sdr.mkv')
  assert.equal(info.video.hdr, false)
  assert.equal(info.video.hdrKind, 'SDR')
  assert.equal(info.audio.label, '无音轨')
})
