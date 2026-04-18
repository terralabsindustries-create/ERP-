interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id?: string;
  handler: (response: any) => void;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => any;
  }
}

export const loadRazorpayScript = (): Promise<boolean> => {
  return new Promise((resolve) => {
    // Check if script is already loaded
    if (window.Razorpay) {
      resolve(true);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    
    script.onload = () => {
      resolve(true);
    };
    
    script.onerror = () => {
      resolve(false);
    };
    
    document.body.appendChild(script);
  });
};

export const openRazorpayPayment = async (options: RazorpayOptions): Promise<void> => {
  const isScriptLoaded = await loadRazorpayScript();
  
  if (!isScriptLoaded) {
    throw new Error('Failed to load Razorpay SDK');
  }
  
  if (!window.Razorpay) {
    throw new Error('Razorpay SDK not loaded');
  }
  
  const razorpay = new window.Razorpay({
    ...options,
    key: options.key || 'rzp_test_SaUSwsnQWzJHbN', // Test key - replace with production key
    theme: {
      color: options.theme?.color || '#3399cc',
    },
  });
  
  razorpay.open();
};

export const createRazorpayOrder = async (planData: {
  planName: string;
  amount: number;
  currency?: string;
  userId?: string;
}): Promise<{ orderId: string; amount: number }> => {
  try {
    const response = await fetch('https://serpy.synxautomate.com/api/razorpay/create-order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: planData.amount * 100, // Razorpay expects amount in paise
        currency: planData.currency || 'INR',
        receipt: `order_${planData.planName}_${Date.now()}`,
        notes: {
          planName: planData.planName,
          userId: planData.userId || 'guest',
        },
      }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to create Razorpay order');
    }
    
    const order = await response.json();
    return {
      orderId: order.id,
      amount: order.amount,
    };
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    throw error;
  }
};

export const verifyPayment = async (paymentData: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): Promise<{ success: boolean; subscriptionId?: string }> => {
  try {
    const response = await fetch('https://serpy.synxautomate.com/api/razorpay/verify-payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paymentData),
    });
    
    if (!response.ok) {
      throw new Error('Payment verification failed');
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error verifying payment:', error);
    throw error;
  }
};
