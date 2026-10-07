// Asks InnerTube for a video's original title, as title un-translators do.
window.__otherExtensionPlayerTitle = async (videoId) => {
  const res = await fetch("/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: window.ytcfg.get("INNERTUBE_CLIENT_VERSION") } },
      videoId,
    }),
  });
  return (await res.json()).videoDetails.title;
};
