// Read the cause before Electron serializes the exception and drops its details.
export function receiverConnectionError(error: unknown): string {
  const errors: Array<{ code?: string; name?: string; message?: string }> = [];
  const visited = new Set<unknown>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const item = value as { code?: string; name?: string; message?: string; cause?: unknown; errors?: unknown[] };
    errors.push(item);
    collect(item.cause);
    if (Array.isArray(item.errors)) item.errors.forEach(collect);
  };
  collect(error);
  const hasCode = (...codes: string[]) => errors.some(item => codes.includes(item.code));

  if (hasCode('CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID')) {
    return '接收端的 HTTPS 证书已过期或尚未生效。请先检查发送电脑的日期和时间；如果时间正确，请接收端管理员更新证书。';
  }
  if (hasCode('ERR_TLS_CERT_ALTNAME_INVALID')) {
    return '接收端地址与 HTTPS 证书上的域名不一致。请核对服务地址，使用证书对应的域名；若地址正确，请接收端管理员修正证书配置。';
  }
  if (hasCode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_UNTRUSTED')) {
    return '无法验证接收端的 HTTPS 证书。可能是证书链不完整，或代理、公司网络使用了应用不信任的证书。\n请尝试切换网络或暂时关闭代理 / VPN 后重试；若仍失败，请管理员检查服务端证书链和应用的证书信任配置。';
  }
  if (hasCode('ENOTFOUND', 'EAI_AGAIN')) {
    return '无法解析接收端域名。请检查服务地址是否拼写正确、电脑是否联网；若域名正确，请切换网络或检查 DNS 设置。';
  }
  if (hasCode('ECONNREFUSED')) {
    return '接收端拒绝连接。请在接收电脑上启动接收服务，并核对服务地址和端口；使用 Cloudflare Tunnel 时，还需确认隧道已启动且指向接收服务。';
  }
  if (hasCode('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT') ||
    errors.some(item => item.name === 'TimeoutError')) {
    return '连接接收端或等待响应超时。请确认接收电脑在线、接收服务和隧道正在运行，再检查发送电脑的网络、代理 / VPN 和防火墙设置。';
  }
  if (hasCode('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET')) {
    return '与接收端的连接中断。请检查两端网络、代理 / VPN 和隧道是否稳定，并确认接收服务仍在运行后重试。';
  }
  if (hasCode('ENETUNREACH', 'EHOSTUNREACH')) {
    return '当前网络无法连接到接收端。请检查电脑网络、代理 / VPN 和防火墙设置，或切换网络后重试。';
  }
  if (errors.some(item => item.message === 'unexpected redirect')) {
    return '接收端地址发生了跳转，应用无法直接访问接口。请填写最终的接收服务地址；若跳转到登录页，请管理员检查网关的访问规则。';
  }
  if (errors.some(item => item.name === 'AbortError')) {
    return '接收端请求已中止。请确认网络和接收服务正常后重试。';
  }
  return '无法完成与接收端的网络通信，暂时无法确定具体原因。\n请在这台发送电脑的浏览器中，打开“接收端服务地址”末尾加上 /healthz 的网址。若未显示 {"ok":true}，请检查地址、接收服务和隧道；若显示正常，请检查应用的代理 / VPN 和证书信任配置，或切换网络后重试。';
}

export function receiverHttpError(status: number): string | undefined {
  switch (status) {
    case 401:
      return '接收端鉴权失败（HTTP 401）。请从接收端复制当前的“鉴权 Token”，替换此处的 Token，确保两端完全一致。';
    case 403:
      return '接收端或网关拒绝访问（HTTP 403）。请核对 Token，并请管理员检查 Cloudflare Access、防火墙或其他网关的访问规则。';
    case 408:
    case 504:
    case 524:
      return `接收端或网关等待响应超时（HTTP ${status}）。请确认接收电脑在线、接收服务和隧道正常，再稍后重试。`;
    case 413:
      return '发送的数据超过接收端或网关的大小限制（HTTP 413）。请减少发送内容，或请管理员检查并调整上传大小限制。';
    case 429:
      return '请求过于频繁（HTTP 429）。请稍等片刻再重试；若持续出现，请管理员检查网关限流设置。';
    default:
      if (status >= 500) {
        return `接收端或网关暂时异常（HTTP ${status}）。请确认接收服务和 Cloudflare Tunnel 正在运行，并检查隧道是否指向正确的本机地址和端口。`;
      }
  }
}
