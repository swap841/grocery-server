const { z } = require("zod");

function isIndianPhoneValid(phone) {
  const num = phone.replace("+91", "");
  if (num.length !== 10) return false;
  if (!/^[6-9]/.test(num)) return false;
  if (/^(\d)\1{9}$/.test(num)) return false;
  return true;
}

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

const sendPhoneOTPSchema = z.object({
  body: z.object({
    phoneNumber: z.string().refine(isIndianPhoneValid, { message: "Enter a valid Indian mobile number (starts with 6-9, 10 digits)" }),
  }),
});

const verifyPhoneOTPSchema = z.object({
  body: z.object({
    phoneNumber: z.string().refine(isIndianPhoneValid, { message: "Enter a valid Indian mobile number (starts with 6-9, 10 digits)" }),
    otp: z.string().length(6, "OTP must be 6 digits"),
  }),
});

const linkPhoneToGoogleSchema = z.object({
  body: z.object({
    phoneNumber: z.string().refine(isIndianPhoneValid, { message: "Enter a valid Indian mobile number (starts with 6-9, 10 digits)" }),
    googleUid: z.string().min(1, "googleUid is required"),
    googleEmail: z.string().email("Invalid email").optional(),
  }),
});

const sendSMSNotificationSchema = z.object({
  body: z.object({
    phoneNumber: z.string().refine(isIndianPhoneValid, { message: "Enter a valid Indian mobile number (starts with 6-9, 10 digits)" }),
    message: z.string().min(1, "Message is required").max(500, "Message too long"),
  }),
});

const orderItemSchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  price: z.number().nonnegative(),
  weight: z.number().nonnegative().optional(),
  imageUrl: z.string().optional(),
});

const deliveryLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  geoHash: z.string().optional(),
  distanceKm: z.number().optional(),
  partition: z.string().optional(),
  deliveryType: z.enum(["own", "thirdParty"]).optional(),
}).nullable().optional();

const createOrderSchema = z.object({
  body: z.object({
    userId: z.string().min(1, "userId is required"),
    orderData: z.object({
      userName: z.string().min(2, "Name must be at least 2 characters"),
      userPhone: z.string().regex(/^\d{10}$/, "Phone must be a 10-digit number"),
      userEmail: z.string().email("Invalid email").optional().or(z.literal("")),
      items: z.array(orderItemSchema).min(1, "At least one item is required"),
      address: z.object({
        name: z.string().min(2, "Name must be at least 2 characters"),
        phone: z.string().regex(/^\d{10}$/, "Phone must be a 10-digit number"),
        addressLine: z.string().min(5, "Address must be at least 5 characters"),
        pincode: z.string().regex(/^\d{6}$/, "Pincode must be a 6-digit number"),
        city: z.string().optional(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
      }).optional(),
      deliveryLocation: deliveryLocationSchema,
      totalAmount: z.number().nonnegative(),
      subtotal: z.number().nonnegative().optional(),
      deliveryCharge: z.number().nonnegative().optional(),
      taxAmount: z.number().nonnegative().optional(),
      totalWeight: z.number().nonnegative().optional(),
      areaCode: z.string().optional(),
      outOfCity: z.boolean().optional(),
    }),
    couponCode: z.string().optional(),
  }),
});

const createRazorpayOrderSchema = z.object({
  body: z.object({
    amount: z.number().positive("Amount must be greater than 0"),
    receipt: z.string().optional(),
  }),
});

const verifyPaymentSchema = z.object({
  body: z.object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
    userId: z.string().min(1),
    orderData: z.object({
      userName: z.string().min(2),
      userPhone: z.string().regex(/^\d{10}$/),
      userEmail: z.string().email().optional().or(z.literal("")),
      items: z.array(orderItemSchema).min(1),
      address: z.object({
        name: z.string().min(2),
        phone: z.string().regex(/^\d{10}$/),
        addressLine: z.string().min(5),
        pincode: z.string().regex(/^\d{6}$/),
        city: z.string().optional(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
      }).optional(),
      deliveryLocation: deliveryLocationSchema,
      totalAmount: z.number().nonnegative(),
      subtotal: z.number().nonnegative().optional(),
    }),
    couponCode: z.string().optional(),
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

const registerFcmTokenSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    fcmToken: z.string().min(20),
    deviceInfo: z.string().optional(),
  }),
});

const sendOTPFcmSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    phoneNumber: z.string().refine(isIndianPhoneValid, { message: "Enter a valid Indian mobile number" }),
  }),
});

const verifyPhoneFcmSchema = z.object({
  body: z.object({
    userId: z.string().min(1),
    phoneNumber: z.string().refine(isIndianPhoneValid, { message: "Enter a valid Indian mobile number" }),
    otp: z.string().length(6, "OTP must be 6 digits"),
  }),
});

module.exports = {
  validate,
  verifyDeliveryCodeSchema,
  dispatchToThirdPartySchema,
  thirdPartyWebhookSchema,
  paySalarySchema,
  sendSMSOTPSchema,
  createOrderSchema,
  createRazorpayOrderSchema,
  verifyPaymentSchema,
  sendPhoneOTPSchema,
  verifyPhoneOTPSchema,
  linkPhoneToGoogleSchema,
  sendSMSNotificationSchema,
  registerFcmTokenSchema,
  sendOTPFcmSchema,
  verifyPhoneFcmSchema,
};
