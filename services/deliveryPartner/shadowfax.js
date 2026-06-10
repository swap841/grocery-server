async function dispatch(order, credentials) {
  const { clientId, clientSecret } = credentials;
  if (!clientId || !clientSecret) throw new Error("Shadowfax: clientId and clientSecret are required");
  const body = {
    client_id: clientId,
    client_secret: clientSecret,
    order_id: order.id,
    pickup_address: order.address?.addressLine || "",
    pickup_phone: order.address?.phone || "",
    delivery_address: order.address?.addressLine || "",
    delivery_phone: order.address?.phone || "",
    delivery_name: order.address?.name || "Customer",
    item_count: (order.items || []).length,
    amount: order.totalAmount || 0,
    payment_type: order.payment?.method === "cod" ? "cod" : "prepaid",
    remarks: `Order ${order.id}`,
  };
  const res = await fetch("https://api.shadowfax.in/v1/order/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shadowfax dispatch failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    trackingId: data.tracking_id || `SF-${order.id}-${Date.now()}`,
    eta: "30-60 minutes",
    raw: data,
  };
}

module.exports = { dispatch };
