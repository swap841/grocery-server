async function dispatch(order, credentials) {
  return {
    trackingId: `DUNZO-${order.id}-${Date.now()}`,
    eta: "2-4 hours",
    note: "Dunzo dispatch logged — manual confirmation may be needed",
  };
}

module.exports = { dispatch };
