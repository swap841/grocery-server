/**
 * Firestore Composite Indexes for the Grocery Ecosystem
 *
 * These indexes MUST be deployed via the Firebase Console or `firebase deploy --only firestore:indexes`
 * at the firebase/ directory level.
 *
 * Usage:
 *   1. Copy the `indexes` array content into firebase/firestore.indexes.json
 *   2. Run: firebase deploy --only firestore:indexes
 */

const indexes = {
  indexes: [
    // Owner dashboard — orders by status across all users
    {
      collectionGroup: "orders",
      queryScope: "COLLECTION_GROUP",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // Owner dashboard — orders by date range
    {
      collectionGroup: "orders",
      queryScope: "COLLECTION_GROUP",
      fields: [
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // Worker — orders by workerId for claimed orders
    {
      collectionGroup: "orders",
      queryScope: "COLLECTION_GROUP",
      fields: [
        { fieldPath: "claimedBy", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // Delivery Boy — assigned baskets
    {
      collectionGroup: "basket",
      queryScope: "COLLECTION_GROUP",
      fields: [
        { fieldPath: "assignedTo", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // User orders — within user subcollection
    {
      collectionId: "orders",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // Worker salaryPayments
    {
      collectionId: "salaryPayments",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "paidAt", order: "DESCENDING" },
      ],
    },
    // Delivery Boy salaryPayments
    {
      collectionId: "salaryPayments",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "paidAt", order: "DESCENDING" },
      ],
    },
    // Worker breakLogs
    {
      collectionId: "breakLogs",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "startTime", order: "DESCENDING" },
      ],
    },
    // Delivery Boy breakLogs
    {
      collectionId: "breakLogs",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "startTime", order: "DESCENDING" },
      ],
    },
    // AI Chats by timestamp
    {
      collectionId: "aiChats",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "userId", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // Contacts by date
    {
      collectionId: "contacts",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // Delivery partner logs by date
    {
      collectionId: "delivery_partner_logs",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    },
    // Salary payments by person
    {
      collectionId: "salaryPayments",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "paidAt", order: "DESCENDING" },
      ],
    },
    // Products by category
    {
      collectionId: "products",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "categoryId", order: "ASCENDING" },
        { fieldPath: "name", order: "ASCENDING" },
      ],
    },
  ],
};

module.exports = indexes;

// Print to stdout for piping
if (require.main === module) {
  console.log(JSON.stringify(indexes, null, 2));
}
