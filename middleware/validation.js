const { z } = require("zod");

const verifyDeliveryCodeSchema = z.object({
  body: z.object({
    orderId: z.string().min(1, "orderId is required"),
    code: z.string().length(6, "Code must be 6 digits"),
  }),
});

const dispatchToThirdPartySchema = z.object({
  body: z.object({
    orderId: z.string().min(1),
    partner: z.enum(["Shiprocket", "Delhivery", "Shadowfax"]),
  }),
});

const thirdPartyWebhookSchema = z.object({
  body: z.object({
    trackingId: z.string().min(1),
    status: z.string().min(1),
    orderId: z.string().optional(),
  }),
});

const paySalarySchema = z.object({
  body: z.object({
    collection: z.enum(["workers", "deliveryBoys"]),
    personId: z.string().min(1),
    amount: z.number().positive(),
    monthYear: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    mode: z.enum(["cash", "bank", "UPI"]),
  }),
});

const sendSMSOTPSchema = z.object({
  body: z.object({
    phoneNumber: z.string().regex(/^\+?\d{10,15}$/),
    otp: z.string().length(6),
  }),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      }));
      return res.status(400).json({ error: "Validation failed", details: errors });
    }
    req.validated = result.data.body;
    next();
  };
}

module.exports = {
  validate,
  verifyDeliveryCodeSchema,
  dispatchToThirdPartySchema,
  thirdPartyWebhookSchema,
  paySalarySchema,
  sendSMSOTPSchema,
};
