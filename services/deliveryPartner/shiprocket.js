async function getToken(credentials) {
  const { email, password } = credentials;
  const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Shiprocket auth failed: ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function dispatch(order, credentials) {
  const token = await getToken(credentials);
  const res = await fetch("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      order_id: order.id,
      order_date: new Date().toISOString().split("T")[0],
      pickup_location: "Primary",
      billing_customer_name: order.address?.name || "Customer",
      billing_address: order.address?.addressLine || "",
      billing_city: order.address?.city || "",
      billing_pincode: order.address?.pincode || "",
      billing_phone: order.address?.phone || "",
      shipping_is_billing: true,
      order_items: (order.items || []).map((item) => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price,
      })),
      payment_method: order.payment?.method === "cod" ? "COD" : "Prepaid",
      sub_total: order.totalAmount || 0,
    }),
  });
  if (!res.ok) throw new Error(`Shiprocket dispatch failed: ${res.status}`);
  const data = await res.json();
  return {
    trackingId: data.shipment_id || data.order_id,
    eta: null,
    raw: data,
  };
}

module.exports = { dispatch };
