import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings,
  ConversationAnalysis,
  SessionMeta,
  SessionRecord,
  Speaker,
  TranscriptSegment,
} from '@transcriber/shared';
import { DEFAULT_SETTINGS, EMPTY_ANALYSIS } from '@transcriber/shared';
import { AudioCapture } from './audio/AudioCapture';
import type { SessionStatus, ModelStatus, ModelProgressEvent } from '@transcriber/core';

type Tab = 'session' | 'history' | 'settings';

interface DisplayBlock {
  key: string;
  speakerId: string;
  text: string;
  partial: boolean;
  startMs: number;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('session');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<SessionStatus>({
    running: false,
    sessionId: null,
    startedAt: null,
    engine: null,
  });
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [finals, setFinals] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState<TranscriptSegment | null>(null);
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [viewing, setViewing] = useState<SessionRecord | null>(null);
  const [analysis, setAnalysis] = useState<ConversationAnalysis>(EMPTY_ANALYSIS);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [modelStatuses, setModelStatuses] = useState<ModelStatus[]>([]);
  const [modelProgress, setModelProgress] = useState<ModelProgressEvent | null>(null);
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);
  const captureRef = useRef(new AudioCapture());
  const transcriptRef = useRef<HTMLDivElement>(null);
  const analysisInFlight = useRef(false);
  const lastAnalyzedCount = useRef(0);

  const refreshSessions = useCallback(async () => {
    const list = await window.transcriber.listSessions();
    setSessions(list);
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await window.transcriber.getSettings();
      setSettings(s);
      const models = await window.transcriber.listModels();
      setModelStatuses(models);
      // Enumerate without opening the mic so Start triggers the real permission prompt.
      const devices = await captureRef.current.listMics();
      setMics(devices);
      await refreshSessions();
    })();

    const offs = [
      window.transcriber.onPartial((seg) => {
        // Empty partial clears the live tip only; keep committed finals.
        if (!seg.text?.trim()) {
          setPartial(null);
          return;
        }
        setPartial(seg);
      }),
      window.transcriber.onFinal((seg) => {
        if (!seg.text?.trim()) return;
        setFinals((prev) => {
          // Avoid exact duplicate consecutive finals
          const last = prev[prev.length - 1];
          if (last && last.text.trim() === seg.text.trim()) return prev;
          return [...prev, seg];
        });
        setPartial(null);
      }),
      window.transcriber.onSpeakers((list) => setSpeakers(list)),
      window.transcriber.onStatus((st) => setStatus(st)),
      window.transcriber.onError((msg) => setError(msg)),
      window.transcriber.onLevels((lv) => setLevels(lv)),
      window.transcriber.onModelProgress((ev) => {
        setModelProgress(ev);
        if (ev.status === 'done' || ev.status === 'error') {
          void window.transcriber.listModels().then(setModelStatuses);
        }
      }),
      window.transcriber.onRecordingSaved((filePath) => {
        setRecordingNotice(`Recording saved: ${filePath}`);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [refreshSessions]);

  useEffect(() => {
    if (!status.running || !status.startedAt) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => {
      setElapsed(Date.now() - (status.startedAt ?? Date.now()));
    }, 250);
    return () => window.clearInterval(id);
  }, [status.running, status.startedAt]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Keep following live text unless the user scrolled up to read history.
    if (distanceFromBottom < 120) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [finals, partial]);

  const activeSpeakers = viewing ? viewing.speakers : speakers;
  const activeSegments = viewing
    ? viewing.segments.filter((s) => s.isFinal)
    : finals;

  const runAnalysis = useCallback(
    async (force = false) => {
      const segs = viewing
        ? viewing.segments.filter((s) => s.isFinal)
        : finals;
      const spks = viewing ? viewing.speakers : speakers;
      if (segs.length === 0) return;
      if (!settings.aiApiKey.trim()) {
        setAnalysisError('Add an AI API key in Settings to enable analysis.');
        return;
      }
      if (analysisInFlight.current) return;
      if (!force && segs.length === lastAnalyzedCount.current) return;

      analysisInFlight.current = true;
      setAnalysisBusy(true);
      setAnalysisError(null);
      try {
        const result = await window.transcriber.analyzeConversation({
          speakers: spks,
          segments: segs,
        });
        setAnalysis(result);
        lastAnalyzedCount.current = segs.length;
      } catch (err) {
        setAnalysisError(err instanceof Error ? err.message : String(err));
      } finally {
        analysisInFlight.current = false;
        setAnalysisBusy(false);
      }
    },
    [finals, speakers, settings.aiApiKey, viewing],
  );

  // Auto-analyze as the conversation grows (debounced).
  useEffect(() => {
    if (!settings.aiAutoAnalyze) return;
    if (!settings.aiApiKey.trim()) return;
    if (activeSegments.length < 2) return;
    if (activeSegments.length === lastAnalyzedCount.current) return;
    const t = window.setTimeout(() => {
      void runAnalysis(false);
    }, 4500);
    return () => window.clearTimeout(t);
  }, [
    activeSegments.length,
    settings.aiAutoAnalyze,
    settings.aiApiKey,
    runAnalysis,
  ]);

  const speakerMap = useMemo(() => {
    const map = new Map(speakers.map((s) => [s.id, s]));
    return map;
  }, [speakers]);

  const blocks: DisplayBlock[] = useMemo(() => {
    const source = viewing
      ? viewing.segments.filter((s) => s.isFinal)
      : finals;
    const chronological: DisplayBlock[] = [];
    for (const seg of source) {
      const last = chronological[chronological.length - 1];
      if (last && last.speakerId === seg.speakerId && !last.partial) {
        last.text = `${last.text} ${seg.text}`.trim();
      } else {
        chronological.push({
          key: seg.id,
          speakerId: seg.speakerId,
          text: seg.text,
          partial: false,
          startMs: seg.startMs,
        });
      }
    }
    if (!viewing && partial?.text) {
      chronological.push({
        key: partial.id,
        speakerId: partial.speakerId,
        text: partial.text,
        partial: true,
        startMs: partial.startMs,
      });
    }
    // Oldest → newest (natural reading order); auto-scroll follows the bottom
    return chronological;
  }, [finals, partial, viewing]);

  async function patchSettings(patch: Partial<AppSettings>) {
    const next = await window.transcriber.setSettings(patch);
    setSettings(next);
  }

  async function selectLocalModel(model: AppSettings['localModel']) {
    await patchSettings({ localModel: model });
    const status = modelStatuses.find((m) => m.model === model);
    if (status?.installed) {
      setModelProgress({ model, percent: 100, status: 'done', message: 'Installed' });
      return;
    }
    setModelProgress({
      model,
      percent: 0,
      status: 'checking',
      message: `Installing ${model}…`,
    });
    try {
      const result = await window.transcriber.ensureModel(model);
      setModelStatuses(await window.transcriber.listModels());
      setModelProgress({
        model,
        percent: 100,
        status: 'done',
        message: result.installed ? 'Installed' : 'Ready',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setModelProgress({ model, percent: 0, status: 'error', message });
      setError(message);
    }
  }

  async function start() {
    setError(null);
    setRecordingNotice(null);
    setViewing(null);
    setFinals([]);
    setPartial(null);
    setSpeakers([]);
    setLevels({ mic: 0, system: 0 });
    setAnalysis(EMPTY_ANALYSIS);
    setAnalysisError(null);
    lastAnalyzedCount.current = 0;
    setBooting(true);

    // Open mic/system audio first so permission prompts and meters work immediately
    // (local model download can take a while and used to block this).
    try {
      await captureRef.current.start({
        micDeviceId: settings.micDeviceId,
        systemAudioEnabled: settings.systemAudioEnabled,
        onLevels: (mic, system) => setLevels({ mic, system }),
        onChunk: (pcm, micLevel, systemLevel) => {
          void window.transcriber.sendPcmChunk({ pcm, micLevel, systemLevel });
        },
      });
    } catch (err) {
      setBooting(false);
      setError(
        err instanceof Error
          ? err.message
          : 'Microphone access failed. Allow mic permission and try again.',
      );
      await captureRef.current.stop();
      return;
    }

    const devices = await captureRef.current.listMics();
    setMics(devices);

    try {
      const st = await window.transcriber.startSession({
        micDeviceId: settings.micDeviceId,
      });
      if (!st.running) {
        await captureRef.current.stop();
        setLevels({ mic: 0, system: 0 });
      }
    } finally {
      setBooting(false);
    }
  }

  async function stop() {
    await captureRef.current.stop();
    await window.transcriber.stopSession();
    await refreshSessions();
  }

  async function loadAudioFile() {
    if (status.running || booting) return;
    setError(null);
    setViewing(null);
    setFinals([]);
    setPartial(null);
    setSpeakers([]);
    setAnalysis(EMPTY_ANALYSIS);
    setAnalysisError(null);
    lastAnalyzedCount.current = 0;
    setBooting(true);
    try {
      const result = await window.transcriber.transcribeFile();
      if (result.canceled) return;
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBooting(false);
    }
  }

  async function renameSpeaker(speakerId: string) {
    const current = speakerMap.get(speakerId)?.label ?? speakerId;
    const next = window.prompt('Rename speaker', current);
    if (!next || next.trim() === current) return;
    const list = await window.transcriber.renameSpeaker(speakerId, next.trim());
    setSpeakers(list);
  }

  async function openSession(id: string) {
    const record = await window.transcriber.getSession(id);
    setViewing(record);
    if (record) {
      setSpeakers(record.speakers);
      setAnalysis(EMPTY_ANALYSIS);
      setAnalysisError(null);
      lastAnalyzedCount.current = 0;
      setTab('session');
    }
  }

  async function exportSession(id: string, format: 'txt' | 'md' | 'json') {
    const { content, filename } = await window.transcriber.exportSession(id, format);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Transcriber</div>
        <nav className="nav">
          <button
            className={tab === 'session' ? 'active' : ''}
            onClick={() => setTab('session')}
          >
            Session
          </button>
          <button
            className={tab === 'history' ? 'active' : ''}
            onClick={() => {
              setTab('history');
              void refreshSessions();
            }}
          >
            History
          </button>
          <button
            className={tab === 'settings' ? 'active' : ''}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
        <div className="spacer" />
        <span className={`badge ${status.running ? 'live' : ''}`}>
          {status.running ? `Live · ${settings.engine}` : settings.engine}
        </span>
      </header>

      {tab === 'session' && (
        <div className="main">
          <aside className="sidebar">
            <div className="panel">
              <h2>Capture</h2>
              <div className="field">
                <label>Microphone</label>
                <select
                  value={settings.micDeviceId}
                  disabled={status.running}
                  onChange={(e) => void patchSettings({ micDeviceId: e.target.value })}
                >
                  <option value="default">System default</option>
                  {mics.map((m) => (
                    <option key={m.deviceId} value={m.deviceId}>
                      {m.label || m.deviceId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.systemAudioEnabled}
                    disabled={status.running}
                    onChange={(e) =>
                      void patchSettings({ systemAudioEnabled: e.target.checked })
                    }
                  />{' '}
                  Capture system audio (Discord / Meet)
                </label>
              </div>
              <div className="field">
                <label>Mic level</label>
                <div className="meter">
                  <span
                    style={{
                      width: `${Math.min(100, Math.sqrt(levels.mic) * 180)}%`,
                    }}
                  />
                </div>
              </div>
              <div className="field">
                <label>System level</label>
                <div className="meter">
                  <span
                    style={{
                      width: `${Math.min(100, Math.sqrt(levels.system) * 180)}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="panel">
              <h2>Speakers</h2>
              <div className="speakers">
                {(viewing ? viewing.speakers : speakers).length === 0 && (
                  <span className="muted">No speakers yet</span>
                )}
                {(viewing ? viewing.speakers : speakers).map((s) => (
                  <button
                    key={s.id}
                    className="speaker-chip"
                    onClick={() => !viewing && void renameSpeaker(s.id)}
                    title="Rename speaker"
                  >
                    <span className="speaker-dot" style={{ background: s.color }} />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <section className="content">
            <div className="controls">
              {!status.running ? (
                <>
                  <button
                    className="primary"
                    disabled={booting}
                    onClick={() => void start()}
                  >
                    {booting ? 'Starting…' : viewing ? 'Start new session' : 'Start'}
                  </button>
                  <button disabled={booting} onClick={() => void loadAudioFile()}>
                    Load audio file
                  </button>
                </>
              ) : (
                <button className="danger" onClick={() => void stop()}>
                  Stop
                </button>
              )}
              <span className="timer">{formatElapsed(elapsed)}</span>
              {viewing && (
                <button
                  onClick={() => {
                    setViewing(null);
                    setSpeakers([]);
                  }}
                >
                  Back to live
                </button>
              )}
            </div>

            {booting && !status.running && (
              <div className="error" style={{ borderColor: 'var(--warning)' }}>
                Working… live capture starts the mic first; file mode may take a minute on
                longer recordings.
              </div>
            )}

            {error && <div className="error">{error}</div>}
            {recordingNotice && (
              <div className="notice">
                {recordingNotice}
                <button
                  type="button"
                  className="notice-dismiss"
                  onClick={() => setRecordingNotice(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="session-split">
              <div className="transcript" ref={transcriptRef}>
                {blocks.length === 0 && (
                  <p className="muted">
                    Start a live session (mic + optional system audio), or load an audio file
                    to transcribe. New lines appear at the bottom.
                  </p>
                )}
                {blocks.map((b) => {
                  const speaker =
                    (viewing
                      ? viewing.speakers.find((s) => s.id === b.speakerId)
                      : speakerMap.get(b.speakerId)) ?? null;
                  const color = speaker?.color ?? '#888';
                  const label = speaker?.label ?? b.speakerId;
                  return (
                    <div key={b.key} className={`block ${b.partial ? 'partial' : ''}`}>
                      <div className="block-head">
                        <span className="speaker-dot" style={{ background: color }} />
                        <button
                          className="speaker-name"
                          style={{ color }}
                          onClick={() => !viewing && void renameSpeaker(b.speakerId)}
                        >
                          {label}
                        </button>
                        <span className="muted" style={{ fontSize: '0.75rem' }}>
                          {formatElapsed(b.startMs)}
                        </span>
                      </div>
                      <p className="block-text">{b.text}</p>
                    </div>
                  );
                })}
              </div>

              <aside className="ai-panel">
                <div className="ai-panel-head">
                  <h2>AI analysis</h2>
                  <button
                    disabled={analysisBusy || activeSegments.length === 0}
                    onClick={() => void runAnalysis(true)}
                  >
                    {analysisBusy ? 'Analyzing…' : 'Refresh'}
                  </button>
                </div>

                {!settings.aiApiKey.trim() && (
                  <p className="muted">
                    Configure an OpenAI-compatible API key in Settings to unlock summaries and
                    reply suggestions.
                  </p>
                )}

                {analysisError && <div className="error">{analysisError}</div>}

                {analysis.summary ? (
                  <>
                    <div className="ai-section">
                      <h3>Summary</h3>
                      <p>{analysis.summary}</p>
                    </div>

                    {analysis.keyPoints.length > 0 && (
                      <div className="ai-section">
                        <h3>Key points</h3>
                        <ul>
                          {analysis.keyPoints.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {analysis.openQuestions.length > 0 && (
                      <div className="ai-section">
                        <h3>Open questions</h3>
                        <ul>
                          {analysis.openQuestions.map((q) => (
                            <li key={q}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {analysis.suggestedReplies.length > 0 && (
                      <div className="ai-section">
                        <h3>Suggested dialogue</h3>
                        <div className="suggestions">
                          {analysis.suggestedReplies.map((s) => (
                            <button
                              key={s}
                              className="suggestion"
                              title="Click to copy"
                              onClick={() => void navigator.clipboard.writeText(s)}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {analysis.updatedAt && (
                      <p className="muted" style={{ fontSize: '0.75rem', marginTop: 'auto' }}>
                        Updated {new Date(analysis.updatedAt).toLocaleTimeString()}
                      </p>
                    )}
                  </>
                ) : (
                  !analysisError &&
                  settings.aiApiKey.trim() && (
                    <p className="muted">
                      {activeSegments.length < 2
                        ? 'Need a bit more conversation before analysis.'
                        : settings.aiAutoAnalyze
                          ? 'Waiting for the next auto-refresh, or hit Refresh.'
                          : 'Hit Refresh to analyze the conversation.'}
                    </p>
                  )
                )}
              </aside>
            </div>
          </section>
        </div>
      )}

      {tab === 'history' && (
        <div className="content" style={{ padding: '1.25rem' }}>
          <div className="panel">
            <h2>Past sessions</h2>
            <div className="history-list">
              {sessions.length === 0 && <p className="muted">No saved sessions yet.</p>}
              {sessions.map((s) => (
                <div key={s.id} className="history-item">
                  <div>
                    <div>{s.title}</div>
                    <div className="muted" style={{ fontSize: '0.8rem' }}>
                      {s.engine} · {s.segmentCount} segments ·{' '}
                      {formatElapsed(s.durationMs)}
                    </div>
                  </div>
                  <div className="history-actions">
                    <button onClick={() => void openSession(s.id)}>Open</button>
                    <button onClick={() => void exportSession(s.id, 'txt')}>TXT</button>
                    <button onClick={() => void exportSession(s.id, 'md')}>MD</button>
                    <button onClick={() => void exportSession(s.id, 'json')}>JSON</button>
                    <button
                      className="danger"
                      onClick={async () => {
                        await window.transcriber.deleteSession(s.id);
                        await refreshSessions();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="content settings-page">
          <header className="settings-header">
            <h1>Settings</h1>
            <p>Configure transcription, recording, and AI analysis.</p>
          </header>

          <div className="settings-layout">
            <section className="panel settings-card">
              <h2>Transcription</h2>
              <p className="settings-card-desc">
                Choose how speech is converted to text during live sessions.
              </p>
              <div className="field">
                <label>Engine</label>
                <select
                  value={settings.engine}
                  disabled={status.running}
                  onChange={(e) =>
                    void patchSettings({ engine: e.target.value as AppSettings['engine'] })
                  }
                >
                  <option value="cloud">Cloud (Deepgram)</option>
                  <option value="local">Local (Whisper)</option>
                </select>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Language</label>
                  <select
                    value={settings.language}
                    onChange={(e) => void patchSettings({ language: e.target.value })}
                  >
                    <option value="en">English</option>
                    <option value="fr">French</option>
                    <option value="es">Spanish</option>
                    <option value="de">German</option>
                    <option value="auto">Auto (local)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Max speakers</label>
                  <select
                    value={String(settings.maxSpeakers)}
                    onChange={(e) =>
                      void patchSettings({
                        maxSpeakers:
                          e.target.value === 'auto' ? 'auto' : Number(e.target.value),
                      })
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5</option>
                  </select>
                </div>
              </div>
            </section>

            <section className="panel settings-card">
              <h2>Recording & window</h2>
              <p className="settings-card-desc">
                Save the mixed mic + system audio from live sessions.
              </p>
              <div className="field field-check">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.recordSessionAudio}
                    onChange={(e) =>
                      void patchSettings({ recordSessionAudio: e.target.checked })
                    }
                  />
                  <span>Record live session audio</span>
                </label>
              </div>
              <div className="field">
                <label>Save recordings to</label>
                <div className="model-row">
                  <input
                    type="text"
                    readOnly
                    disabled={!settings.recordSessionAudio}
                    value={
                      settings.recordingFolder.trim() || 'Downloads (default)'
                    }
                    title={
                      settings.recordingFolder.trim() || 'System Downloads folder'
                    }
                  />
                  <button
                    type="button"
                    disabled={!settings.recordSessionAudio}
                    onClick={() => {
                      void (async () => {
                        const result = await window.transcriber.pickRecordingFolder();
                        if (!result.canceled) {
                          setSettings(await window.transcriber.getSettings());
                        }
                      })();
                    }}
                  >
                    Browse…
                  </button>
                  {settings.recordingFolder.trim() ? (
                    <button
                      type="button"
                      disabled={!settings.recordSessionAudio}
                      onClick={() => {
                        void (async () => {
                          const next = await window.transcriber.clearRecordingFolder();
                          setSettings(next);
                        })();
                      }}
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
                <p className="hint">WAV file written when you stop a live session.</p>
              </div>
              <div className="field field-check">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.alwaysOnTop}
                    onChange={(e) => {
                      void patchSettings({ alwaysOnTop: e.target.checked });
                      void window.transcriber.setAlwaysOnTop(e.target.checked);
                    }}
                  />
                  <span>Keep window always on top</span>
                </label>
              </div>
            </section>

            <section
              className={`panel settings-card${
                settings.engine !== 'local' ? ' settings-card-muted' : ''
              }`}
            >
              <h2>Local Whisper</h2>
              <p className="settings-card-desc">
                Offline models. Base is included; others download when selected.
              </p>
              <div className="field">
                <label>Model</label>
                <div className="model-row">
                  <select
                    value={settings.localModel}
                    onChange={(e) =>
                      void selectLocalModel(
                        e.target.value as AppSettings['localModel'],
                      )
                    }
                  >
                    <option value="tiny">tiny (fastest)</option>
                    <option value="base">base</option>
                    <option value="small">small (recommended)</option>
                    <option value="medium">medium (accurate, heavier)</option>
                  </select>
                  {(() => {
                    const current = modelStatuses.find(
                      (m) => m.model === settings.localModel,
                    );
                    const progressForSelected =
                      modelProgress?.model === settings.localModel
                        ? modelProgress
                        : null;
                    const downloading =
                      progressForSelected?.status === 'downloading' ||
                      progressForSelected?.status === 'checking' ||
                      current?.downloading;
                    const percent = downloading
                      ? progressForSelected?.percent ?? current?.percent ?? 0
                      : current?.installed
                        ? 100
                        : 0;
                    const label = downloading
                      ? `Installing ${percent}%`
                      : current?.installed
                        ? 'Installed'
                        : progressForSelected?.status === 'error'
                          ? 'Failed'
                          : 'Not installed';
                    return (
                      <div className="model-install">
                        <div className="meter model-meter" title={label}>
                          <span style={{ width: `${percent}%` }} />
                        </div>
                        <span
                          className={`model-status${
                            progressForSelected?.status === 'error'
                              ? ' model-status-error'
                              : ''
                          }`}
                        >
                          {label}
                        </span>
                      </div>
                    );
                  })()}
                </div>
                {modelProgress?.model === settings.localModel &&
                  modelProgress.status === 'error' &&
                  modelProgress.message && (
                    <p className="hint model-error">{modelProgress.message}</p>
                  )}
              </div>
              <div className="field">
                <label>Hugging Face token (optional)</label>
                <input
                  type="password"
                  value={settings.huggingfaceToken}
                  placeholder="hf_..."
                  onChange={(e) =>
                    void patchSettings({ huggingfaceToken: e.target.value })
                  }
                />
                <p className="hint">Only needed for some gated diarization models.</p>
              </div>
            </section>

            <section
              className={`panel settings-card${
                settings.engine !== 'cloud' ? ' settings-card-muted' : ''
              }`}
            >
              <h2>Cloud Deepgram</h2>
              <p className="settings-card-desc">
                Best for live multi-speaker calls when you have network access.
              </p>
              <div className="field">
                <label>API key</label>
                <input
                  type="password"
                  value={settings.deepgramApiKey}
                  placeholder="Token for cloud engine"
                  onChange={(e) =>
                    void patchSettings({ deepgramApiKey: e.target.value })
                  }
                />
              </div>
            </section>

            <section className="panel settings-card settings-card-wide">
              <h2>AI analysis</h2>
              <p className="settings-card-desc">
                OpenAI-compatible Chat Completions API for the live analysis panel
                (OpenAI, Azure proxy, OpenRouter, etc.).
              </p>
              <div className="field-row">
                <div className="field">
                  <label>API key</label>
                  <input
                    type="password"
                    value={settings.aiApiKey}
                    placeholder="sk-..."
                    onChange={(e) => void patchSettings({ aiApiKey: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Model</label>
                  <input
                    type="text"
                    value={settings.aiModel}
                    placeholder="gpt-4o-mini"
                    onChange={(e) => void patchSettings({ aiModel: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  type="text"
                  value={settings.aiBaseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => void patchSettings({ aiBaseUrl: e.target.value })}
                />
              </div>
              <div className="field field-check">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.aiAutoAnalyze}
                    onChange={(e) =>
                      void patchSettings({ aiAutoAnalyze: e.target.checked })
                    }
                  />
                  <span>Auto-refresh analysis as the conversation grows</span>
                </label>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
