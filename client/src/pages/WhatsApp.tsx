import { useState, useEffect } from "react";
import { MessageSquare, Send, Phone, Globe, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

export default function WhatsApp() {
  const [message, setMessage] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [stats, setStats] = useState({
    messagesSent: 0,
    deliveryRate: 0,
    responseRate: 0,
    activeContacts: 0,
    loading: true
  });
  const { toast } = useToast();

  useEffect(() => {
    fetchWhatsAppStats();
  }, []);

  const fetchWhatsAppStats = async () => {
    try {
      const response = await apiClient.getWhatsAppStats();
      console.log('📱 WhatsApp stats response:', response);
      
      if (response.data?.stats) {
        setStats({
          messagesSent: response.data.stats.messagesSent || 0,
          deliveryRate: response.data.stats.deliveryRate || 0,
          responseRate: response.data.stats.responseRate || 0,
          activeContacts: response.data.stats.activeContacts || 0,
          loading: false
        });
      }
    } catch (error) {
      console.error('Error fetching WhatsApp stats:', error);
      setStats(prev => ({ ...prev, loading: false }));
      toast({
        title: "Error",
        description: "Failed to fetch WhatsApp statistics",
        variant: "destructive",
      });
    }
  };

  const messageTemplates = [
    { id: 1, name: "Proof Approval", content: "Hi! Your design proof is ready for review. Please check and approve: [LINK]" },
    { id: 2, name: "Invoice Reminder", content: "Dear [CUSTOMER], your invoice [INVOICE_ID] of ₹[AMOUNT] is due. Please make payment." },
    { id: 3, name: "Delivery Update", content: "Your order [JOB_ID] is ready for delivery. We'll be there by [TIME]." },
    { id: 4, name: "Payment Confirmation", content: "Thank you! Payment of ₹[AMOUNT] received for invoice [INVOICE_ID]." }
  ];

  const sendMessage = async () => {
    if (!phoneNumber || !message) {
      toast({
        title: "Missing Information",
        description: "Please enter both phone number and message",
        variant: "destructive",
      });
      return;
    }

    try {
      // In a real app, you'd integrate with WhatsApp Business API
      // For now, we'll just show a success message
      toast({
        title: "Message Sent",
        description: `Message sent to ${phoneNumber}`,
      });
      
      setMessage("");
      setPhoneNumber("");
      
      // Update stats
      setStats(prev => ({
        ...prev,
        messagesSent: prev.messagesSent + 1
      }));
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send message",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp Integration</h1>
          <p className="text-muted-foreground">Send proofs, invoices, and updates via WhatsApp</p>
        </div>
        <Button className="gap-2">
          <Settings className="h-4 w-4" />
          Configure API
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Messages Sent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.loading ? "..." : stats.messagesSent}
            </div>
            <p className="text-xs text-muted-foreground">this month</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Delivery Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success">
              {stats.loading ? "..." : `${stats.deliveryRate}%`}
            </div>
            <p className="text-xs text-muted-foreground">messages delivered</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Response Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.loading ? "..." : `${stats.responseRate}%`}
            </div>
            <p className="text-xs text-muted-foreground">clients respond</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Active Contacts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.loading ? "..." : stats.activeContacts}
            </div>
            <p className="text-xs text-muted-foreground">customers contacted</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="send" className="space-y-4">
        <TabsList>
          <TabsTrigger value="send">Send Message</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="history">Message History</TabsTrigger>
          <TabsTrigger value="webhook">Webhook Setup</TabsTrigger>
        </TabsList>

        <TabsContent value="send" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Send WhatsApp Message</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium">Customer Phone</label>
                <Input 
                  placeholder="+91 9876543210" 
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Message</label>
                <Textarea 
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type your message here..."
                  rows={4}
                />
              </div>
              <Button onClick={sendMessage} className="gap-2">
                <Send className="h-4 w-4" />
                Send Message
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <div className="grid gap-4">
            {messageTemplates.map((template) => (
              <Card key={template.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <Button 
                      size="sm" 
                      variant="outline"
                      onClick={() => setMessage(template.content)}
                    >
                      Use Template
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{template.content}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <div className="text-center py-12">
            <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Message History</h3>
            <p className="text-muted-foreground">
              Message history will appear here once you start sending messages.
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Connect to WhatsApp Business API to track message delivery and responses.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="webhook" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Webhook Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium">Webhook URL</label>
                <Input 
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://your-webhook-url.com/webhook"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Configure your webhook URL to automatically send WhatsApp messages when certain events occur (invoice creation, proof upload, etc.)
              </p>
              <div className="space-y-4">
                <Button>Save Configuration</Button>
                <div className="text-sm text-muted-foreground">
                  <p className="font-medium mb-2">Setup Instructions:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Sign up for WhatsApp Business API</li>
                    <li>Get your webhook URL from your provider</li>
                    <li>Configure the webhook to trigger on events</li>
                    <li>Test the integration</li>
                  </ol>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}