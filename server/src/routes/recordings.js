import express, { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { config } from '../config.js';
import {
  addChunk, deleteRecording, liveOn, myRecordings, recordingEnabled, reportRecording, startRecording, stopRecording, toRecording,
} from '../recordings.js';

/** Trip audio recording for riders and drivers (step 8b batch F). See src/recordings.js. */

const router = Router();
router.use(requireAuth, requireRole('rider', 'driver'));

router.get('/', async (req, res) => {
  const rideId = req.query.rideId ? String(req.query.rideId) : null;
  res.json({
    enabled: recordingEnabled(),
    keepDays: config.recording.keepDays,
    recordings: await myRecordings(req.user.id, rideId),
    // Who is recording this ride now, so the other person always knows.
    liveOnRide: rideId ? await liveOn(rideId, req.user.id) : [],
  });
});

router.post('/', async (req, res) => {
  const rec = await startRecording(req.user, String(req.body?.rideId ?? ''), req.body?.mimeType);
  res.status(201).json({ recording: toRecording(rec), chunkSeconds: 30, maxHours: config.recording.maxHours });
});

router.put('/:id/chunks/:seq', express.raw({ type: () => true, limit: config.recording.chunkMaxBytes + 1 }), async (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const rec = await addChunk(req.user, req.params.id, Number(req.params.seq), bytes);
  res.json({ recording: toRecording(rec) });
});

router.post('/:id/stop', async (req, res) => {
  res.json({ recording: toRecording(await stopRecording(req.user, req.params.id)) });
});

router.post('/:id/report', async (req, res) => {
  res.json({ recording: toRecording(await reportRecording(req.user, req.params.id, req.body?.reason)) });
});

router.delete('/:id', async (req, res) => {
  await deleteRecording(req.user, req.params.id);
  res.json({ ok: true });
});

export default router;
