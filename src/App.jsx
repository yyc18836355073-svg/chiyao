import React, { useState, useEffect, useRef } from 'react';
import { enablePush, scheduleReminder, cancelReminders } from './push.js';

// 本地存储 KEY 定义
const STORAGE_KEYS = {
  START_DATE: 'hp_start_date',
  LOGS: 'hp_logs_v1',
  LAST_MORNING: 'hp_last_morning_ts',
  ACTIVE_TIMER: 'hp_active_timer_v1',
};

// 默认 14 天结构初始化
const createInitialLogs = () => {
  const logs = {};
  for (let i = 1; i <= 14; i++) {
    logs[i] = {
      morning: false,
      morningTime: null,
      evening: false,
      eveningTime: null,
    };
  }
  return logs;
};

// 本地时区日期 YYYY-MM-DD（避免 toISOString 的 UTC 偏移导致日期差一天）
const getLocalDateStr = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function App() {
  const [startDate, setStartDate] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.START_DATE) || getLocalDateStr();
  });

  const [logs, setLogs] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.LOGS);
    return saved ? JSON.parse(saved) : createInitialLogs();
  });

  const [lastMorningTs, setLastMorningTs] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.LAST_MORNING);
    return saved ? parseInt(saved, 10) : 0;
  });

  const [activeTimer, setActiveTimer] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.ACTIVE_TIMER);
    return saved ? JSON.parse(saved) : null;
  });

  const [currentPeriod, setCurrentPeriod] = useState('morning');
  const [nowTs, setNowTs] = useState(Date.now());
  const [notificationGranted, setNotificationGranted] = useState(false);
  const [selectedDayModal, setSelectedDayModal] = useState(null);
  const [showEmergencyUnlockModal, setShowEmergencyUnlockModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  const alertTriggeredRef = useRef(false);

  // 动态同步时间戳 (抗 iOS 后台冻结机制)
  useEffect(() => {
    const timer = setInterval(() => {
      setNowTs(Date.now());
    }, 500);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setNowTs(Date.now());
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if ('Notification' in window) {
      setNotificationGranted(Notification.permission === 'granted');
    }

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.START_DATE, startDate);
  }, [startDate]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(logs));
  }, [logs]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LAST_MORNING, lastMorningTs.toString());
  }, [lastMorningTs]);

  useEffect(() => {
    if (activeTimer) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_TIMER, JSON.stringify(activeTimer));
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_TIMER);
    }
  }, [activeTimer]);

  const calculateCurrentDayNum = () => {
    const start = new Date(startDate + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffTime = today.getTime() - start.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 3600 * 24)) + 1;
    return Math.min(Math.max(diffDays, 1), 14);
  };

  const currentDayNum = calculateCurrentDayNum();

  // Web Audio API 声音合成（无外部音源依赖）
  const playAlertSound = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      
      const playTone = (freq, startTime, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + startTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime + startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + startTime);
        osc.stop(ctx.currentTime + startTime + duration);
      };

      playTone(523.25, 0, 0.25);
      playTone(659.25, 0.2, 0.25);
      playTone(783.99, 0.4, 0.4);
    } catch (e) {
      console.warn('播放提示音失败:', e);
    }
  };

  const triggerSystemNotification = (title, body) => {
    if ('vibrate' in navigator) {
      navigator.vibrate([300, 150, 300, 150, 400]);
    }
    playAlertSound();

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body,
          icon: './pwa-192x192.png',
          tag: 'hp-reminder',
          requireInteraction: true
        });
      } catch (e) {
        console.warn('触发通知失败:', e);
      }
    }
  };

  const requestNotification = () => {
    enablePush().then((res) => {
      setNotificationGranted(res.ok && Notification.permission === 'granted');
      if (!res.ok && res.error) alert('开启推送失败：' + res.error);
    });
  };

  // 监听倒计时结束
  useEffect(() => {
    if (!activeTimer) {
      alertTriggeredRef.current = false;
      return;
    }

    const remainingSec = Math.max(0, Math.floor((activeTimer.targetTs - nowTs) / 1000));

    if (remainingSec === 0 && !alertTriggeredRef.current) {
      alertTriggeredRef.current = true;

      if (activeTimer.stage === 'PRE_MEAL') {
        setActiveTimer(prev => ({ ...prev, stage: 'READY_TO_EAT' }));
        triggerSystemNotification(
          '🍚 30分钟倒计时结束：请开始用餐！',
          '抑酸药与胃粘膜保护膜已到位，请正常用餐。吃完饭后请开启抗生素倒计时。'
        );
      } else if (activeTimer.stage === 'POST_MEAL') {
        setActiveTimer(prev => ({ ...prev, stage: 'READY_FOR_ANTIBIOTIC' }));
        triggerSystemNotification(
          '💊 饭后15分钟到：该吃抗生素了！',
          '请及时服用抗生素。饭后服用可降低胃部刺激。'
        );
      }
    }
  }, [nowTs, activeTimer]);

  // 启动倒计时时，把提醒计划上报给推送服务（后台到点也会推送）
  useEffect(() => {
    if (!activeTimer) return;

    let title = '';
    let body = '';
    if (activeTimer.stage === 'PRE_MEAL') {
      title = '🍚 30分钟倒计时结束：请开始用餐！';
      body = '抑酸药与胃粘膜保护膜已到位，请正常用餐。吃完饭后请开启抗生素倒计时。';
    } else if (activeTimer.stage === 'POST_MEAL') {
      title = '💊 饭后15分钟到：该吃抗生素了！';
      body = '请及时服用抗生素。饭后服用可降低胃部刺激。';
    }
    if (!title) return;

    scheduleReminder({ at: activeTimer.targetTs, title, body });
    return () => {
      cancelReminders();
    };
  }, [activeTimer]);

  // 10 小时防呆锁定判定
  const getSafetyLockInfo = () => {
    if (currentPeriod !== 'evening' || lastMorningTs === 0) {
      return { isLocked: false, remainingSec: 0 };
    }

    const elapsedMs = nowTs - lastMorningTs;
    const TEN_HOURS_MS = 10 * 60 * 60 * 1000;

    if (elapsedMs < TEN_HOURS_MS) {
      return {
        isLocked: true,
        remainingSec: Math.ceil((TEN_HOURS_MS - elapsedMs) / 1000),
      };
    }
    return { isLocked: false, remainingSec: 0 };
  };

  const safetyLock = getSafetyLockInfo();

  const formatSeconds = (totalSec) => {
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hours > 0) {
      return `${pad(hours)}小时${pad(mins)}分${pad(secs)}秒`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  };

  const handleStartPreMeal = () => {
    if (safetyLock.isLocked) {
      alert('🔒 抗生素间隔锁定中！为确保疗效与肠道安全，两次服药需间隔10-12小时。');
      return;
    }

    const durationMins = 30;
    const targetTs = Date.now() + durationMins * 60 * 1000;

    if (currentPeriod === 'morning') {
      setLastMorningTs(Date.now());
    }

    alertTriggeredRef.current = false;
    setActiveTimer({
      stage: 'PRE_MEAL',
      period: currentPeriod,
      targetTs,
      duration: durationMins,
      dayNum: currentDayNum,
    });
  };

  const handleFinishedMeal = () => {
    const durationMins = 15;
    const targetTs = Date.now() + durationMins * 60 * 1000;

    alertTriggeredRef.current = false;
    setActiveTimer({
      stage: 'POST_MEAL',
      period: currentPeriod,
      targetTs,
      duration: durationMins,
      dayNum: currentDayNum,
    });
  };

  const handleConfirmDoseComplete = () => {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    setLogs(prev => {
      const dayData = prev[currentDayNum] || { morning: false, evening: false };
      return {
        ...prev,
        [currentDayNum]: {
          ...dayData,
          [currentPeriod]: true,
          [`${currentPeriod}Time`]: timeStr,
        }
      };
    });
    setActiveTimer(null);
  };

  const handleResetTimer = () => {
    if (window.confirm('确定要重置当前的服药倒计时吗？')) {
      setActiveTimer(null);
    }
  };

  const handleToggleLogSlot = (dayNum, periodKey) => {
    setLogs(prev => {
      const dayData = prev[dayNum] || { morning: false, evening: false };
      const currentVal = dayData[periodKey];
      const timeStr = !currentVal ? new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : null;
      return {
        ...prev,
        [dayNum]: {
          ...dayData,
          [periodKey]: !currentVal,
          [`${periodKey}Time`]: timeStr,
        }
      };
    });
  };

  const totalDosesDone = Object.values(logs).reduce((acc, curr) => {
    return acc + (curr.morning ? 1 : 0) + (curr.evening ? 1 : 0);
  }, 0);
  const progressPercent = Math.round((totalDosesDone / 28) * 100);

  const getDayDateLabel = (dayIndex) => {
    const d = new Date(startDate + 'T00:00:00');
    d.setDate(d.getDate() + (dayIndex - 1));
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div className="max-w-md mx-auto min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-between p-4 pb-safe select-none">
      
      {/* 头部进度与提醒 */}
      <header className="space-y-3 pt-2">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-sky-400 flex items-center gap-1.5">
              <span>💊</span> 幽门螺杆菌四联打卡
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">14天规范疗程 · 科学抗酸与抗生素防呆</p>
          </div>
          <button
            onClick={() => setShowSettingsModal(true)}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 text-xs flex items-center gap-1"
          >
            <span>⚙️</span> 设置
          </button>
        </div>

        {!notificationGranted && (
          <div 
            onClick={requestNotification}
            className="bg-amber-950/80 border border-amber-600/50 rounded-xl p-2.5 text-xs text-amber-200 flex justify-between items-center cursor-pointer active:scale-98 transition-transform"
          >
            <div className="flex items-center gap-2">
              <span className="text-base">🔔</span>
              <span>建议开启系统通知，后台倒计时结束自动提醒</span>
            </div>
            <span className="font-semibold text-amber-400 bg-amber-900/60 px-2 py-1 rounded-lg">开启</span>
          </div>
        )}

        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-3.5 space-y-2">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-300 font-medium">当前疗程：第 <strong className="text-sky-400 text-sm">{currentDayNum}</strong> / 14 天</span>
            <span className="text-sky-400 font-bold">{totalDosesDone} / 28 顿 ({progressPercent}%)</span>
          </div>
          <div className="w-full bg-slate-700 h-2.5 rounded-full overflow-hidden">
            <div 
              className="bg-gradient-to-r from-sky-500 to-emerald-400 h-full transition-all duration-500 rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </header>

      {/* 核心操作区域 */}
      <main className="my-4 space-y-4 flex-1 flex flex-col justify-center">
        <div className="grid grid-cols-2 gap-2 p-1 bg-slate-800 rounded-xl border border-slate-700">
          <button
            onClick={() => setCurrentPeriod('morning')}
            className={`py-2.5 rounded-lg font-medium text-sm transition-all flex justify-center items-center gap-1.5 ${
              currentPeriod === 'morning'
                ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>🌅</span> 早餐服药
            {logs[currentDayNum]?.morning && <span className="text-xs bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">已打卡</span>}
          </button>

          <button
            onClick={() => setCurrentPeriod('evening')}
            className={`py-2.5 rounded-lg font-medium text-sm transition-all flex justify-center items-center gap-1.5 ${
              currentPeriod === 'evening'
                ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>🌙</span> 晚餐服药
            {logs[currentDayNum]?.evening && <span className="text-xs bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">已打卡</span>}
          </button>
        </div>

        {/* 10小时安全锁卡片 */}
        {currentPeriod === 'evening' && safetyLock.isLocked && !activeTimer && (
          <div className="bg-amber-950/40 border-2 border-amber-600/60 rounded-3xl p-5 text-center space-y-3.5 backdrop-blur">
            <div className="w-14 h-14 bg-amber-900/60 border border-amber-500/40 rounded-full flex items-center justify-center mx-auto text-2xl shadow-inner">
              🔒
            </div>
            <div>
              <h3 className="text-lg font-bold text-amber-300">抗生素间隔安全锁保护中</h3>
              <p className="text-xs text-amber-200/80 mt-1 max-w-xs mx-auto leading-relaxed">
                四联疗法要求两次抗生素间隔 <strong className="text-amber-100">10 - 12 小时</strong>，以维持稳态血药浓度并保护肠道。
              </p>
            </div>

            <div className="bg-slate-900/80 border border-amber-500/30 rounded-2xl p-3">
              <span className="text-xs text-slate-400 block mb-1">距离晚餐建议开启时间还剩</span>
              <span className="text-2xl font-mono font-bold text-amber-400 tracking-wider">
                {formatSeconds(safetyLock.remainingSec)}
              </span>
            </div>

            <button
              onClick={() => setShowEmergencyUnlockModal(true)}
              className="text-xs text-amber-500/80 hover:text-amber-400 underline pt-1 block mx-auto"
            >
              特殊情况：紧急解除安全锁
            </button>
          </div>
        )}

        {/* 倒计时与流程控制 */}
        {(!safetyLock.isLocked || currentPeriod === 'morning' || activeTimer) && (
          <div className="bg-slate-800/80 border border-slate-700/80 rounded-3xl p-5 text-center space-y-4 shadow-xl">
            {!activeTimer && (
              <div className="space-y-4 py-2">
                <div className="bg-slate-900/60 rounded-2xl p-3.5 text-left border border-slate-700/60 space-y-2 text-xs">
                  <div className="font-semibold text-sky-300 text-sm flex items-center justify-between">
                    <span>{currentPeriod === 'morning' ? '🌅 早餐' : '🌙 晚餐'} 标准四联服药流程</span>
                    <span className="text-slate-400 text-xs">总用时约 45 分钟</span>
                  </div>
                  <ul className="space-y-1.5 text-slate-300 list-disc list-inside">
                    <li><strong className="text-sky-200">饭前30分钟：</strong> PPI (抑酸剂) + 铋剂 (保护胃粘膜)</li>
                    <li><strong className="text-amber-200">饭后15分钟：</strong> 2 种抗生素 (减轻肠胃刺激)</li>
                  </ul>
                </div>

                <button
                  onClick={handleStartPreMeal}
                  className="w-full py-4 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 active:scale-95 text-white font-bold text-lg rounded-2xl shadow-lg shadow-sky-600/30 transition-all flex items-center justify-center gap-2"
                >
                  <span>🥣</span> 吃完饭前药（开启30分钟倒计时）
                </button>
              </div>
            )}

            {activeTimer?.stage === 'PRE_MEAL' && (
              <div className="space-y-4 py-1">
                <div className="inline-block bg-sky-950/80 text-sky-300 border border-sky-600/40 text-xs px-3 py-1 rounded-full">
                  阶段 1/2：抑酸剂与铋剂起效中
                </div>

                <div className="py-2">
                  <span className="text-5xl font-mono font-bold tracking-tight text-sky-400 drop-shadow-md">
                    {formatSeconds(Math.max(0, Math.floor((activeTimer.targetTs - nowTs) / 1000)))}
                  </span>
                  <p className="text-xs text-slate-400 mt-2">请等待 30 分钟，使抑酸药充分吸收形成胃粘膜保护</p>
                </div>

                <button onClick={handleResetTimer} className="text-xs text-slate-400 hover:text-slate-200 underline">
                  误触/取消倒计时
                </button>
              </div>
            )}

            {activeTimer?.stage === 'READY_TO_EAT' && (
              <div className="space-y-4 py-1 animate-pulse">
                <div className="bg-emerald-950/80 border-2 border-emerald-500/80 rounded-2xl p-4 text-emerald-200 text-sm space-y-1">
                  <p className="text-lg font-bold text-emerald-300">🍚 30 分钟已到，请开始用餐！</p>
                  <p className="text-xs text-emerald-200/80">胃粘膜保护屏障已形成。用餐结束后请点击开启抗生素倒计时。</p>
                </div>

                <button
                  onClick={handleFinishedMeal}
                  className="w-full py-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 active:scale-95 text-white font-bold text-lg rounded-2xl shadow-lg shadow-emerald-600/30 transition-all flex items-center justify-center gap-2"
                >
                  <span>🍱</span> 我吃完饭了（开启15分钟倒计时）
                </button>
              </div>
            )}

            {activeTimer?.stage === 'POST_MEAL' && (
              <div className="space-y-4 py-1">
                <div className="inline-block bg-teal-950/80 text-teal-300 border border-teal-600/40 text-xs px-3 py-1 rounded-full">
                  阶段 2/2：饭后消化缓冲中
                </div>

                <div className="py-2">
                  <span className="text-5xl font-mono font-bold tracking-tight text-teal-400 drop-shadow-md">
                    {formatSeconds(Math.max(0, Math.floor((activeTimer.targetTs - nowTs) / 1000)))}
                  </span>
                  <p className="text-xs text-slate-400 mt-2">饭后 15 分钟服用抗生素可减少胃部恶心感</p>
                </div>

                <button onClick={handleResetTimer} className="text-xs text-slate-400 hover:text-slate-200 underline">
                  误触/取消倒计时
                </button>
              </div>
            )}

            {activeTimer?.stage === 'READY_FOR_ANTIBIOTIC' && (
              <div className="space-y-4 py-1 animate-pulse">
                <div className="bg-indigo-950/80 border-2 border-indigo-500/80 rounded-2xl p-4 text-indigo-200 text-sm space-y-1">
                  <p className="text-lg font-bold text-indigo-300">💊 15 分钟已到：请服用抗生素！</p>
                  <p className="text-xs text-indigo-200/80">请温水送服 2 种抗生素。服药后点击下方按钮完成打卡。</p>
                </div>

                <button
                  onClick={handleConfirmDoseComplete}
                  className="w-full py-4 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 active:scale-95 text-white font-bold text-lg rounded-2xl shadow-lg shadow-indigo-600/30 transition-all flex items-center justify-center gap-2"
                >
                  <span>✅</span> 确认已服“饭后药”（打卡完成）
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* 14 天打卡网格日历 */}
      <section className="space-y-2.5">
        <div className="flex justify-between items-center text-xs">
          <h2 className="font-bold text-slate-200 flex items-center gap-1">
            <span>📅</span> 14 天打卡日历视图
          </h2>
          <span className="text-slate-400">点击日期可手动补打卡</span>
        </div>

        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: 14 }).map((_, idx) => {
            const dayNum = idx + 1;
            const dayLog = logs[dayNum] || { morning: false, evening: false };
            const isToday = dayNum === currentDayNum;

            return (
              <div
                key={dayNum}
                onClick={() => setSelectedDayModal(dayNum)}
                className={`p-1.5 rounded-xl border text-center cursor-pointer transition-all active:scale-95 flex flex-col justify-between h-20 ${
                  isToday
                    ? 'bg-slate-800 border-sky-500 shadow-md shadow-sky-950'
                    : 'bg-slate-800/60 border-slate-700/60 hover:bg-slate-800'
                }`}
              >
                <div className="text-[10px] text-slate-400 font-mono flex justify-between items-center">
                  <span>D{dayNum}</span>
                  <span>{getDayDateLabel(dayNum)}</span>
                </div>

                <div className="space-y-1 my-auto">
                  <div className={`text-[10px] py-0.5 rounded font-medium flex items-center justify-center gap-0.5 ${
                    dayLog.morning 
                      ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-600/40' 
                      : 'bg-slate-900/60 text-slate-500'
                  }`}>
                    <span>早</span>
                    <span>{dayLog.morning ? '✓' : '•'}</span>
                  </div>

                  <div className={`text-[10px] py-0.5 rounded font-medium flex items-center justify-center gap-0.5 ${
                    dayLog.evening 
                      ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-600/40' 
                      : 'bg-slate-900/60 text-slate-500'
                  }`}>
                    <span>晚</span>
                    <span>{dayLog.evening ? '✓' : '•'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 补打卡 Modal */}
      {selectedDayModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-5 w-full max-w-xs space-y-4 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-700 pb-2.5">
              <h3 className="font-bold text-sky-400">
                第 {selectedDayModal} 天打卡记录 ({getDayDateLabel(selectedDayModal)})
              </h3>
              <button onClick={() => setSelectedDayModal(null)} className="text-slate-400 hover:text-slate-200 text-sm font-bold">
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center bg-slate-900/60 p-3 rounded-2xl border border-slate-700">
                <div>
                  <span className="text-sm font-medium text-slate-200">🌅 早餐服药</span>
                  <span className="text-xs block text-slate-400">
                    {logs[selectedDayModal]?.morningTime ? `完成于 ${logs[selectedDayModal].morningTime}` : '未完成'}
                  </span>
                </div>
                <button
                  onClick={() => handleToggleLogSlot(selectedDayModal, 'morning')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                    logs[selectedDayModal]?.morning
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {logs[selectedDayModal]?.morning ? '已完成 (撤销)' : '标记完成'}
                </button>
              </div>

              <div className="flex justify-between items-center bg-slate-900/60 p-3 rounded-2xl border border-slate-700">
                <div>
                  <span className="text-sm font-medium text-slate-200">🌙 晚餐服药</span>
                  <span className="text-xs block text-slate-400">
                    {logs[selectedDayModal]?.eveningTime ? `完成于 ${logs[selectedDayModal].eveningTime}` : '未完成'}
                  </span>
                </div>
                <button
                  onClick={() => handleToggleLogSlot(selectedDayModal, 'evening')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                    logs[selectedDayModal]?.evening
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {logs[selectedDayModal]?.evening ? '已完成 (撤销)' : '标记完成'}
                </button>
              </div>
            </div>

            <button
              onClick={() => setSelectedDayModal(null)}
              className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-xl"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 解除安全锁警告 Modal */}
      {showEmergencyUnlockModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-amber-600/80 rounded-3xl p-5 w-full max-w-xs space-y-4 text-center shadow-2xl">
            <div className="text-3xl">⚠️</div>
            <h3 className="font-bold text-amber-400">解除间隔安全锁警告</h3>
            <p className="text-xs text-slate-300 text-left leading-relaxed">
              提前服用第二次抗生素可能导致血药浓度过高或剧烈消化道反应。请仅在跨时区、作息倒班等极特殊情况下解除。
            </p>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowEmergencyUnlockModal(false)}
                className="flex-1 py-2.5 bg-slate-700 text-slate-300 text-xs font-bold rounded-xl"
              >
                保持锁定
              </button>
              <button
                onClick={() => {
                  setLastMorningTs(0);
                  setShowEmergencyUnlockModal(false);
                }}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl"
              >
                强制解锁
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 设置与说明 Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-5 w-full max-w-sm space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-slate-700 pb-2.5">
              <h3 className="font-bold text-sky-400">应用设置与疗程说明</h3>
              <button onClick={() => setShowSettingsModal(false)} className="text-slate-400 hover:text-slate-200 text-sm font-bold">
                ✕
              </button>
            </div>

            <div className="space-y-1.5 text-xs text-left">
              <label className="font-semibold text-slate-300">疗程开始日期：</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl p-2 text-slate-100 font-mono"
              />
            </div>

            <div className="bg-slate-900/80 p-3 rounded-2xl border border-slate-700/80 text-left text-xs space-y-2 text-slate-300 leading-relaxed">
              <p className="font-bold text-sky-300">💡 标准四联疗法提示：</p>
              <p>1. <strong>饭前药 (PPI+铋剂)：</strong> 饭前30分钟服用，抑酸并保护胃黏膜屏障。</p>
              <p>2. <strong>饭后药 (2种抗生素)：</strong> 饭后15-30分钟服用，缓冲消化并降低胃肠刺激。</p>
              <p>3. <strong>严禁饮酒：</strong> 服药期间及停药一周内严禁接触任何酒精。</p>
            </div>

            <div className="space-y-2 pt-2">
              <button
                onClick={requestNotification}
                className="w-full py-2.5 bg-sky-700 hover:bg-sky-600 text-white text-xs font-bold rounded-xl"
              >
                重新申请系统提醒权限
              </button>
              <button
                onClick={() => {
                  if (window.confirm('警告：这将会清空所有历史打卡记录。确定继续吗？')) {
                    localStorage.clear();
                    setLogs(createInitialLogs());
                    setLastMorningTs(0);
                    setActiveTimer(null);
                    setStartDate(getLocalDateStr());
                    setShowSettingsModal(false);
                  }
                }}
                className="w-full py-2.5 bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-700/50 text-xs font-bold rounded-xl"
              >
                重置所有打卡数据
              </button>
            </div>

            <button
              onClick={() => setShowSettingsModal(false)}
              className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded-xl"
            >
              返回主界面
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

