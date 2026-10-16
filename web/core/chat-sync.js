import { useEffect } from 'preact/hooks';
export function useChatSync({
  api,
  conversation,
  session,
  job,
  reconnectEpoch,
  chatEpoch,
  jobRef,
  sending,
  setMessages,
  setProposals,
  setJob,
  setHistoryLoading,
  setReconnecting,
  setReconnectEpoch,
  setError,
  setConversations,
  setConversationInfo,
  setSelected,
  setFrameEpoch,
  refresh,
  historyPages,
}) {
  useEffect(() => {
    const epoch = ++chatEpoch.current;
    if (!conversation || !session?.authenticated) {
      setMessages([]);
      setProposals([]);
      setJob(null);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    let active = true;
    let retryTimer;
    const observedJob = jobRef.current?.id;
    (async () => {
      try {
        const current = await api(`/api/conversations/${conversation}/info`);
        const tracked = current?.job || current?.latestReplyJob;
        const running = tracked ? await api(`/api/jobs/${tracked}`) : null;
        // Read history after job state: a terminal job will not be polled again,
        // so its final messages must be included in this snapshot.
        const [values, suggestions, chats] = await Promise.all([
          historyPages.read(conversation),
          api(`/api/conversations/${conversation}/proposals`),
          historyPages.list(),
        ]);
        if (!active || chatEpoch.current !== epoch) return;
        setReconnecting(false);
        if (!sending.current && (!jobRef.current || jobRef.current.id === observedJob)) {
          setMessages(values);
          setProposals(suggestions);
        }
        setConversations(chats);
        setConversationInfo(current);
        if (current?.app) setSelected(current.app);
        // A send may have started while history was loading.
        if (!sending.current && (!jobRef.current || jobRef.current.id === observedJob))
          setJob(running);
      } catch (e) {
        if (active && chatEpoch.current === epoch) {
          if (['unauthorized', 'not_found', 'validation'].includes(e.code)) {
            setReconnecting(false);
            setError(e.message);
          } else {
            setReconnecting(true);
            retryTimer = setTimeout(() => setReconnectEpoch((v) => v + 1), 2000);
          }
        }
      } finally {
        if (active && chatEpoch.current === epoch) setHistoryLoading(false);
      }
    })();
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [conversation, session?.authenticated, reconnectEpoch]);
  useEffect(() => {
    if (!session?.authenticated || !job || !['running', 'queued'].includes(job.state)) return;
    const epoch = chatEpoch.current;
    let active = true,
      inFlight = false,
      historyVersion = job.payload?.historyVersion || 0;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const value = await api(`/api/jobs/${job.id}`);
        if (active) setReconnecting(false);
        if (!active || epoch !== chatEpoch.current) return;
        if (
          !['running', 'queued'].includes(value.state) ||
          (value.payload?.historyVersion || 0) !== historyVersion
        ) {
          const [values, suggestions] = await Promise.all([
            historyPages.read(conversation),
            api(`/api/conversations/${conversation}/proposals`),
          ]);
          if (active && epoch === chatEpoch.current) {
            historyVersion = value.payload?.historyVersion || 0;
            setMessages(values);
            setProposals(suggestions);
            setJob(value);
            // App chat may have changed its records without changing its revision.
            setFrameEpoch((current) => current + 1);
          }
          await refresh();
        } else setJob(value);
      } catch (e) {
        if (active) {
          if (e.code === 'unauthorized') setError(e.message);
          else setReconnecting(true);
        }
      } finally {
        inFlight = false;
      }
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.state, conversation, session?.authenticated, reconnectEpoch]);
  useEffect(() => {
    const reconnect = () => setReconnectEpoch((v) => v + 1);
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', reconnect);
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('focus', reconnect);
    };
  }, []);
}
