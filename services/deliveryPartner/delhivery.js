async function getToken(credentials) {
  const { apiKey } = credentials;
  if (!apiKey) throw new Error("Delhivery: apiKey is required");
  return apiKey;
}

async function dispatch(order, credentials) {
  const token = await getToken(credentials);
  const waybill = `DH-${order.id}-${Date.now()}`;
  const body = {
    shipment: [{
      waybill,
      order_id: order.id,
      name: order.address?.name || "Customer",
      add: order.address?.addressLine || "",
      city: order.address?.city || "",
      pin_code: order.address?.pincode || "",
      phone: order.address?.phone || "",
      order_date: new Date().toISOString().split("T")[0],
      total_amount: order.totalAmount || 0,
      cod_amount: order.payment?.method === "cod" ? (order.totalAmount || 0) : 0,
      dimensions: { length: 10, width: 10, height: 10, weight: order.totalWeight ? Math.ceil(order.totalWeight / 1000) : 1 },
      items: (order.items || []).map((item) => ({
        name: item.name,
        qty: item.quantity,
        price: item.price,
      })),
    }],
    pickup_location: "Primary",
    pickup_time: new Date().toISOString(),
  };
  const res = await fetch("https://track.delhivery.com/api/p/packet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && text.includes("already exists")) {
      return { trackingId: waybill, eta: "24-72 hours" };
    }
    throw new Error(`Delhivery dispatch failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    trackingId: data.packages?.[0]?.waybill || waybill,
    eta: "24-72 hours",
    raw: data,
  };
}

async function track(trackingId, credentials) {
  const token = await getToken(credentials);
  const res = await fetch(`https://track.delhivery.com/api/v1/packages/json/${trackingId}`, {
    headers: { Authorization: `Token ${token}` },
  });
  if (!res.ok) return { trackingId, status: "unknown" };
  const data = await res.json();
  const lastScan = data.ShipmentData?.[0]?.Shipment?.Status?.Status;
  return { trackingId, status: lastScan || "in_transit" };
}

module.exports = { dispatch, track };
